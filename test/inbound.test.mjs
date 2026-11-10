import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InboundJournal, inboundKey } from '../src/store/inbound.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

async function reopen(stateDir, botId = 'bot1') {
  const journal = new InboundJournal({ stateDir, botId })
  await journal.load()
  return journal
}

async function fixture(t, botId = 'bot1') {
  const stateDir = await makeTempDir('inbound')
  t.after(() => cleanup(stateDir))
  return { stateDir, journal: await reopen(stateDir, botId) }
}

function persistenceError(error) {
  assert.equal(error.message, 'Could not persist inbound message tracking.')
  assert.equal(error.code, 'inbound-persistence')
  assert.ok(error.cause instanceof Error)
  assert.equal(typeof error.cause.code, 'string')
  return true
}

const entry = { userId: 'u1', messageId: '7', phase: 'queued', acceptedAt: 123 }
const document = (entries = [entry]) => ({ version: 1, botId: 'bot1', entries })

test('missing journal loads empty and flush and absent mutations write nothing', async (t) => {
  const { journal, stateDir } = await fixture(t)
  assert.equal(journal.file, join(stateDir, 'inbound', 'bot1.json'))
  assert.deepEqual(journal.entries(), [])
  assert.equal(journal.has('u1', 7), false)
  assert.equal(await journal.markSubmitting('u1', 7), false)
  await journal.remove([inboundKey('u1', 7)])
  await journal.flush()
  await assert.rejects(stat(journal.file), { code: 'ENOENT' })
  await assert.rejects(stat(dirname(journal.file)), { code: 'ENOENT' })
})

test('metadata roundtrips with phases and owner-only file and directory permissions', async (t) => {
  const botId = '../bot:1/微信'
  const { journal, stateDir } = await fixture(t, botId)
  assert.equal(journal.file, join(stateDir, 'inbound', '.._bot_1___.json'))
  const before = Date.now()
  const pending = journal.record({ fromUserId: 'u1', messageId: 7, contextToken: 'ctx1' })
  assert.equal(journal.has('u1', 7), false)
  assert.equal(await pending, true)
  const accepted = journal.entries()[0]
  assert.ok(accepted.acceptedAt >= before && accepted.acceptedAt <= Date.now())
  assert.deepEqual(accepted, { ...entry, contextToken: 'ctx1', acceptedAt: accepted.acceptedAt })
  await journal.record({ fromUserId: 'u2', messageId: '8' })
  const submitting = journal.markSubmitting('u1', 7)
  assert.equal(journal.entries()[0].phase, 'queued')
  assert.equal(await submitting, true)
  const saved = JSON.parse(await readFile(journal.file, 'utf8'))
  assert.deepEqual(saved, { version: 1, botId, entries: journal.entries() })
  assert.equal(saved.entries[0].phase, 'submitting')
  assert.equal(Object.hasOwn(saved.entries[1], 'contextToken'), false)
  assert.deepEqual((await reopen(stateDir, botId)).entries(), journal.entries())
  if (process.platform !== 'win32') {
    assert.equal((await stat(journal.file)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(journal.file))).mode & 0o777, 0o700)
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
  }
})

test('repeated records retain submitting phase, original timestamp and context token', async (t) => {
  const { journal, stateDir } = await fixture(t)
  await journal.record({ fromUserId: 'u1', messageId: 7, contextToken: 'original' })
  await journal.markSubmitting('u1', '7')
  const expected = journal.entries()
  const text = await readFile(journal.file, 'utf8')
  assert.deepEqual(await Promise.all([
    journal.record({ fromUserId: 'u1', messageId: '7', contextToken: 'replacement' }),
    journal.record({ fromUserId: 'u1', messageId: 7 }),
    journal.markSubmitting('u1', 7),
  ]), [false, false, true])
  assert.deepEqual(journal.entries(), expected)
  assert.equal(await readFile(journal.file, 'utf8'), text)
  assert.deepEqual((await reopen(stateDir)).entries(), expected)
})

test('entries are independent metadata copies and normalized payload and media secrets are never saved', async (t) => {
  const { journal, stateDir } = await fixture(t)
  const message = {
    fromUserId: 'u1', messageId: '7', contextToken: 'reply-context',
    text: 'private prompt text',
    images: [{ full_url: 'https://cdn.example/image?secret=cdn-token', aes_key: 'secret-aes-key' }],
    content: [{ type: 'image', data: 'secret-image-bytes' }],
    botToken: 'secret-bot-token',
  }
  const pending = journal.record(message)
  message.contextToken = 'changed-outside'
  await pending
  const expected = [{ ...entry, contextToken: 'reply-context', acceptedAt: journal.entries()[0].acceptedAt }]
  const copies = journal.entries()
  copies[0].phase = 'submitting'
  copies[0].userId = 'other'
  copies[0].contextToken = 'tampered'
  copies.push({ ...entry })
  assert.deepEqual(journal.entries(), expected)
  const text = await readFile(journal.file, 'utf8')
  assert.deepEqual(JSON.parse(text), document(expected))
  for (const secret of ['private prompt text', 'cdn-token', 'secret-aes-key', 'secret-image-bytes', 'secret-bot-token']) {
    assert.equal(text.includes(secret), false)
  }
  assert.deepEqual((await reopen(stateDir)).entries(), expected)
})

test('load reconstructs only explicit metadata fields, dropping unknown payload fields on the next write', async (t) => {
  const { journal, stateDir } = await fixture(t)
  await mkdir(dirname(journal.file))
  await writeFile(journal.file, JSON.stringify({
    ...document([{ ...entry, text: 'secret-text', images: [{ aes_key: 'secret-key' }], extra: {} }]),
    payload: 'secret-document',
  }))
  await journal.load()
  assert.deepEqual(journal.entries(), [entry])
  await journal.markSubmitting('u1', 7)
  assert.deepEqual(JSON.parse(await readFile(journal.file, 'utf8')), document([{ ...entry, phase: 'submitting' }]))
  assert.deepEqual((await reopen(stateDir)).entries(), [{ ...entry, phase: 'submitting' }])
})

for (const [name, text] of [
  ['malformed JSON', '{not-json'],
  ['null document', 'null'],
  ['array document', '[]'],
  ['string document', '"journal"'],
  ['number document', '1'],
  ['boolean document', 'true'],
  ['missing fields', '{}'],
  ['missing version', JSON.stringify({ botId: 'bot1', entries: [] })],
  ['wrong version', JSON.stringify({ ...document(), version: 2 })],
  ['string version', JSON.stringify({ ...document(), version: '1' })],
  ['missing account', JSON.stringify({ version: 1, entries: [] })],
  ['wrong account', JSON.stringify({ ...document(), botId: 'bot2' })],
  ['non-string account', JSON.stringify({ ...document(), botId: 1 })],
  ['missing entries', JSON.stringify({ version: 1, botId: 'bot1' })],
  ['null entries', JSON.stringify({ ...document(), entries: null })],
  ['object entries', JSON.stringify({ ...document(), entries: {} })],
  ['string entries', JSON.stringify({ ...document(), entries: 'entries' })],
  ['null entry', JSON.stringify(document([null]))],
  ['array entry', JSON.stringify(document([[]]))],
  ['string entry', JSON.stringify(document(['entry']))],
  ['number entry', JSON.stringify(document([7]))],
  ['empty entry', JSON.stringify(document([{}]))],
  ...[
    ['userId', undefined], ['userId', ''], ['userId', 7], ['userId', null],
    ['messageId', undefined], ['messageId', ''], ['messageId', 7], ['messageId', null],
    ['phase', undefined], ['phase', 'finished'], ['phase', 1], ['phase', null],
    ['acceptedAt', undefined], ['acceptedAt', -1], ['acceptedAt', 0.5],
    ['acceptedAt', Number.MAX_SAFE_INTEGER + 1], ['acceptedAt', '123'], ['acceptedAt', null],
    ['contextToken', null], ['contextToken', 7], ['contextToken', {}], ['contextToken', []],
  ].map(([field, value]) => [
    `invalid ${field} ${JSON.stringify(value)}`,
    JSON.stringify(document([entry, { ...entry, userId: 'u2', [field]: value }])),
  ]),
  ['infinite timestamp', '{"version":1,"botId":"bot1","entries":[{"userId":"u1","messageId":"7","phase":"queued","acceptedAt":1e400}]}'],
  ['duplicate identities', JSON.stringify(document([entry, { ...entry, phase: 'submitting' }]))],
]) {
  test(`load fails closed for ${name} without replacing the document`, async (t) => {
    const { journal } = await fixture(t)
    await mkdir(dirname(journal.file))
    await writeFile(journal.file, text)
    await assert.rejects(journal.load())
    assert.deepEqual(journal.entries(), [])
    await assert.rejects(journal.record({ fromUserId: 'new-user', messageId: 99 }))
    await assert.rejects(journal.markSubmitting('u1', 7))
    await assert.rejects(journal.remove([inboundKey('u1', 7)]))
    await journal.flush()
    assert.equal(await readFile(journal.file, 'utf8'), text)
  })
}

test('a failed reload leaves the previous snapshot intact and a repaired load recovers', async (t) => {
  const { journal } = await fixture(t)
  await journal.record({ fromUserId: 'u1', messageId: 7 })
  const expected = journal.entries()
  await writeFile(journal.file, JSON.stringify(document([entry, { ...entry, userId: 'u2', phase: 'invalid' }])))
  await assert.rejects(journal.load())
  assert.deepEqual(journal.entries(), expected)
  await writeFile(journal.file, JSON.stringify(document(expected)))
  await journal.load()
  assert.equal(await journal.markSubmitting('u1', 7), true)
})

test('failed records publish nothing, wrap the filesystem cause and leave retries usable', async (t) => {
  const { journal, stateDir } = await fixture(t)
  const file = journal.file
  journal.file = stateDir
  await Promise.all([
    assert.rejects(journal.record({ fromUserId: 'u1', messageId: 7 }), persistenceError),
    assert.rejects(journal.record({ fromUserId: 'u2', messageId: 7 }), persistenceError),
  ])
  assert.equal(journal.has('u1', 7), false)
  assert.equal(journal.has('u2', 7), false)
  assert.deepEqual(journal.entries(), [])
  await journal.flush()
  journal.file = file
  await assert.rejects(stat(file), { code: 'ENOENT' })
  assert.deepEqual(await Promise.all([
    journal.record({ fromUserId: 'u1', messageId: 7 }),
    journal.record({ fromUserId: 'u2', messageId: 7 }),
  ]), [true, true])
  assert.deepEqual((await reopen(stateDir)).entries(), journal.entries())
})

for (const action of ['remove', 'submitting']) {
  test(`failed ${action} retains live and persisted state, then retries successfully`, async (t) => {
    const { journal, stateDir } = await fixture(t)
    await journal.record({ fromUserId: 'u1', messageId: 7 })
    await journal.record({ fromUserId: 'u2', messageId: 7 })
    const previous = journal.entries()
    const file = journal.file
    const text = await readFile(file, 'utf8')
    const mutate = () => action === 'remove'
      ? journal.remove([inboundKey('u1', 7)])
      : journal.markSubmitting('u1', 7)
    journal.file = stateDir
    await assert.rejects(mutate(), persistenceError)
    await assert.rejects(mutate(), persistenceError)
    assert.deepEqual(journal.entries(), previous)
    await journal.flush()
    assert.equal(await readFile(file, 'utf8'), text)
    assert.deepEqual((await reopen(stateDir)).entries(), previous)
    journal.file = file
    await mutate()
    const expected = action === 'remove' ? [previous[1]] : [{ ...previous[0], phase: 'submitting' }, previous[1]]
    assert.deepEqual(journal.entries(), expected)
    assert.deepEqual((await reopen(stateDir)).entries(), expected)
  })
}

test('concurrent sender records, phases, reloads and removals serialize without lost updates or resurrection', async (t) => {
  const { journal, stateDir } = await fixture(t)
  const pending = []
  for (let index = 0; index < 20; index += 1) {
    const userId = `u${index}`
    pending.push(journal.record({ fromUserId: userId, messageId: 7 }))
    if (index % 2 === 0) pending.push(journal.markSubmitting(userId, 7))
    if (index % 5 === 0) pending.push(journal.load())
    if (index % 3 === 0) {
      pending.push(journal.remove([inboundKey(userId, 7)]))
      pending.push(journal.markSubmitting(userId, 7).then((result) => assert.equal(result, false)))
    }
  }
  await journal.flush()
  await Promise.all(pending)
  const entries = journal.entries()
  assert.equal(entries.length, 13)
  for (let index = 0; index < 20; index += 1) {
    const found = entries.find((value) => value.userId === `u${index}`)
    if (index % 3 === 0) assert.equal(found, undefined)
    else assert.equal(found.phase, index % 2 === 0 ? 'submitting' : 'queued')
  }
  assert.deepEqual((await reopen(stateDir)).entries(), entries)
})

test('identity keys preserve separators and uint64 strings, and removal matches only exact keys', async (t) => {
  const { journal, stateDir } = await fixture(t)
  const pairs = [
    ['a:b', 'c'], ['a', 'b:c'], ['a|b', 'c'], ['a', 'b|c'],
    ['user"\\\n', 'id"\\\n'], ['__proto__', '7'],
    ['u1', '18446744073709551615'], ['u1', '18446744073709551614'],
    ['u2', '18446744073709551615'],
  ]
  assert.equal(inboundKey('u1', 7), JSON.stringify(['u1', '7']))
  assert.equal(new Set(pairs.map(([userId, messageId]) => inboundKey(userId, messageId))).size, pairs.length)
  await Promise.all(pairs.map(([fromUserId, messageId]) => journal.record({ fromUserId, messageId })))
  assert.ok(pairs.every(([userId, messageId]) => journal.has(userId, messageId)))
  await journal.remove(['a:b:c', 'u1', '18446744073709551615', 'missing', JSON.stringify(['u1', 7])])
  assert.equal(journal.entries().length, pairs.length)
  const removed = [inboundKey('a:b', 'c'), inboundKey('u1', '18446744073709551615')]
  await journal.remove([...removed, ...removed])
  assert.equal(journal.entries().length, pairs.length - 2)
  assert.equal(journal.has('a:b', 'c'), false)
  assert.equal(journal.has('a', 'b:c'), true)
  assert.equal(journal.has('u1', '18446744073709551614'), true)
  assert.equal(journal.has('u2', '18446744073709551615'), true)
  assert.deepEqual((await reopen(stateDir)).entries(), journal.entries())
})

test('mutations on a fresh instance load existing tracking rather than overwriting it', async (t) => {
  const { journal, stateDir } = await fixture(t)
  await journal.record({ fromUserId: 'u1', messageId: 7 })
  const fresh = new InboundJournal({ stateDir, botId: 'bot1' })
  await fresh.record({ fromUserId: 'u2', messageId: 8 })
  assert.equal(fresh.has('u1', 7), true)
  assert.equal(fresh.has('u2', 8), true)
  assert.deepEqual((await reopen(stateDir)).entries(), fresh.entries())
})
