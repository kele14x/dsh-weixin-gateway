import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChannelState } from '../src/store/state.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

/**
 * @param {object} [options] - state options.
 * @returns {Promise<ChannelState>} loaded state.
 */
async function loadedState(dir, options = {}) {
  const state = new ChannelState({ stateDir: dir, botId: 'bot1', ...options })
  await state.load()
  return state
}

test('cursor persists and an empty cursor is ignored', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setCursor('')
  assert.equal(state.cursor, '')

  await state.setCursor('cursor-1')
  const reopened = await loadedState(dir)
  assert.equal(reopened.cursor, 'cursor-1')
})

for (const field of ['cursor', 'contextToken']) {
  for (const concurrent of [false, true]) {
    test(`${field} same-value ${concurrent ? 'concurrent callers and retries' : 'retry'} persists after a failed write`, async (t) => {
      const dir = await makeTempDir('state-retry')
      t.after(() => cleanup(dir))
      const state = await loadedState(dir)
      const update = () => field === 'cursor'
        ? state.setCursor('cursor-1')
        : state.setContextToken('user-1', 'ctx-1')
      await writeFile(state.dir, 'disposable write obstruction')
      if (concurrent) {
        const results = await Promise.allSettled([update(), update()])
        assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected'])
      } else {
        await assert.rejects(update)
      }
      await rm(state.dir)
      await update()
      const reopened = await loadedState(dir)
      if (field === 'cursor') assert.equal(reopened.cursor, 'cursor-1')
      else assert.equal(reopened.contextTokenFor('user-1'), 'ctx-1')
    })
  }
}

test('session mappings survive a reload', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setSession('user-1', { sessionId: 'session-1', cwd: '/tmp' })

  const reopened = await loadedState(dir)
  const mapping = reopened.sessionFor('user-1')
  assert.equal(mapping?.sessionId, 'session-1')
  assert.equal(mapping?.cwd, '/tmp')
})

test('context tokens are remembered per sender', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setContextToken('user-1', 'ctx-1')
  await state.setContextToken('user-2', 'ctx-2')

  const reopened = await loadedState(dir)
  assert.equal(reopened.contextTokenFor('user-1'), 'ctx-1')
  assert.equal(reopened.contextTokenFor('user-2'), 'ctx-2')
})

test('checking a message identity does not remember or persist it', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))
  const state = await loadedState(dir)
  assert.equal(state.hasSeen('user-1', 7), false)
  assert.equal(state.hasSeen('user-1', 7), false)
  await state.flush()
  await assert.rejects(readFile(state.file), { code: 'ENOENT' })
  assert.equal(state.isDuplicate('user-1', 7), false)
  assert.equal(state.hasSeen('user-1', 7), true)
  assert.equal(state.hasSeen('user-2', 7), false)
  await state.flush()
  assert.equal((await loadedState(dir)).hasSeen('user-1', 7), true)
})

test('dedupe detects a repeated message id and keeps ids scoped per sender', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  assert.equal(state.isDuplicate('user-1', 7), false)
  assert.equal(state.isDuplicate('user-1', 7), true)
  assert.equal(state.isDuplicate('user-2', 7), false)
})

test('dedupe window is bounded', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir, { dedupeLimit: 5 })
  for (let index = 0; index < 20; index += 1) state.isDuplicate('user-1', index)
  assert.ok(state.seen.size <= 5)
})

test('state files are written with mode 0600', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setCursor('cursor-1')
  const info = await stat(join(dir, 'state', 'bot1.json'))
  // Windows has no POSIX mode bits and reports every regular file as 0o666.
  if (process.platform !== 'win32') {
    assert.equal(info.mode & 0o777, 0o600)
  }
})

test('a corrupt state file is reported instead of replaced', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))
  const file = join(dir, 'state', 'bot1.json')
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(file, '{not json', 'utf8')

  const state = new ChannelState({ stateDir: dir, botId: 'bot1' })
  await assert.rejects(() => state.load(), /not valid JSON/)
})

test('approval ids start at 1 and return decimal strings', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  assert.equal(state.approvalCounters.size, 0)
  assert.equal(await state.nextApprovalId('user-1'), '1')
  assert.equal(await state.nextApprovalId('user-1'), '2')
})

test('approval counters are independent per sender', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  assert.equal(await state.nextApprovalId('user-1'), '1')
  assert.equal(await state.nextApprovalId('user-2'), '1')
  assert.equal(await state.nextApprovalId('user-1'), '2')
  assert.equal(await state.nextApprovalId('user-2'), '2')
})

test('approval counters persist in version 1 state and continue after reload', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.nextApprovalId('user-1')
  await state.nextApprovalId('user-1')
  await state.nextApprovalId('user-2')
  const document = JSON.parse(await readFile(state.file, 'utf8'))
  assert.equal(document.version, 1)
  assert.deepEqual(document.approvalCounters, { 'user-1': 2, 'user-2': 1 })

  const reopened = await loadedState(dir)
  assert.deepEqual(reopened.approvalCounters, new Map([['user-1', 2], ['user-2', 1]]))
  assert.equal(await reopened.nextApprovalId('user-1'), '3')
  assert.equal(await reopened.nextApprovalId('user-2'), '2')
})

test('concurrent approval ids are distinct and persisted before returning amid other updates', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  const returned = new Map([['user-1', []], ['user-2', []]])
  const allocate = async (userId) => {
    const id = await state.nextApprovalId(userId)
    const document = JSON.parse(await readFile(state.file, 'utf8'))
    assert.match(id, /^[1-9][0-9]*$/)
    assert.ok(Number(id) <= document.approvalCounters[userId])
    returned.get(userId).push(id)
  }
  const pending = []
  for (let index = 0; index < 10; index += 1) {
    pending.push(
      allocate('user-1').then(() => allocate('user-1')),
      state.setCursor(`cursor-${index}`),
      allocate('user-2').then(() => allocate('user-2')),
      state.setContextToken('user-1', `ctx-${index}`),
      state.setSession('user-1', { sessionId: `session-${index}`, cwd: '/tmp' }),
      state.touchSession('user-1'),
    )
  }
  await Promise.all(pending)

  const expected = Array.from({ length: 20 }, (_, index) => index + 1)
  for (const ids of returned.values()) {
    assert.equal(new Set(ids).size, 20)
    assert.deepEqual(ids.map(Number).sort((a, b) => a - b), expected)
  }
  const reopened = await loadedState(dir)
  assert.deepEqual(reopened.approvalCounters, new Map([['user-1', 20], ['user-2', 20]]))
  assert.equal(reopened.cursor, 'cursor-9')
  assert.equal(reopened.contextTokenFor('user-1'), 'ctx-9')
  assert.equal(reopened.sessionFor('user-1')?.sessionId, 'session-9')
})

test('setting, touching, dropping and replacing session mappings never resets approval counters', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  assert.equal(await state.nextApprovalId('user-1'), '1')
  await state.setSession('user-1', { sessionId: 'session-1', cwd: '/tmp' })
  assert.equal(state.approvalCounters.get('user-1'), 1)
  await state.touchSession('user-1')
  assert.equal(state.approvalCounters.get('user-1'), 1)
  await state.setSession('user-1', { sessionId: 'session-2', cwd: '/tmp' })
  assert.equal(state.approvalCounters.get('user-1'), 1)
  await state.dropSession('user-1')
  assert.equal(state.approvalCounters.get('user-1'), 1)
  await state.touchSession('user-1')
  await state.dropSession('user-1')
  assert.equal(state.approvalCounters.get('user-1'), 1)
  await state.setSession('user-1', { sessionId: 'session-new', cwd: '/tmp' })
  const document = JSON.parse(await readFile(state.file, 'utf8'))
  assert.deepEqual(document.approvalCounters, { 'user-1': 1 })

  const reopened = await loadedState(dir)
  assert.equal(reopened.sessionFor('user-1')?.sessionId, 'session-new')
  assert.equal(await reopened.nextApprovalId('user-1'), '2')
})

test('legacy state without approval counters loads empty and preserves existing fields', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))
  const file = join(dir, 'state', 'bot1.json')
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    cursor: 'legacy-cursor',
    contextTokens: { 'user-1': 'legacy-context' },
    sessions: { 'user-1': { sessionId: 'legacy-session', cwd: '/tmp' } },
  }))

  const state = await loadedState(dir)
  assert.equal(state.approvalCounters.size, 0)
  assert.equal(state.cursor, 'legacy-cursor')
  assert.equal(state.contextTokenFor('user-1'), 'legacy-context')
  assert.equal(state.sessionFor('user-1')?.sessionId, 'legacy-session')
  await state.setCursor('new-cursor')
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.approvalCounters, {})
  assert.equal(await state.nextApprovalId('user-1'), '1')
})

test('persisted zero and positive approval counters load without resetting', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))
  const file = join(dir, 'state', 'bot1.json')
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    approvalCounters: { 'user-1': 0, 'user-2': 7 },
  }))

  const state = await loadedState(dir)
  assert.equal(await state.nextApprovalId('user-1'), '1')
  assert.equal(await state.nextApprovalId('user-2'), '8')
})

for (const obstruction of ['state directory file', 'state file directory']) {
  for (const concurrent of [false, true]) {
    test(`approval allocation ${concurrent ? 'concurrent failures' : 'failure'} with ${obstruction} returns no id and safely retries`, async (t) => {
      const dir = await makeTempDir('state-approval-retry')
      t.after(() => cleanup(dir))
      const state = await loadedState(dir)
      let previous = 0
      let path = state.dir
      if (obstruction === 'state file directory') {
        assert.equal(await state.nextApprovalId('user-1'), '1')
        previous = 1
        path = state.file
        await rm(path)
        await mkdir(path)
      } else {
        await writeFile(path, 'disposable write obstruction')
      }

      const attempts = concurrent ? 2 : 1
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => state.nextApprovalId('user-1')),
      )
      assert.deepEqual(results.map((result) => result.status), Array(attempts).fill('rejected'))
      assert.equal(state.approvalCounters.get('user-1'), previous + attempts)
      await rm(path, { recursive: true })
      assert.equal(await state.nextApprovalId('user-1'), String(previous + attempts + 1))
      const document = JSON.parse(await readFile(state.file, 'utf8'))
      assert.equal(document.approvalCounters['user-1'], previous + attempts + 1)
      const reopened = await loadedState(dir)
      assert.equal(await reopened.nextApprovalId('user-1'), String(previous + attempts + 2))
    })
  }
}

for (const [name, counters] of [
  ['null container', 'null'],
  ['array container', '[]'],
  ['nonempty array container', '[1]'],
  ['string container', '"1"'],
  ['number container', '1'],
  ['boolean container', 'true'],
  ['negative counter', '{"user-1":-1}'],
  ['fractional counter', '{"user-1":0.5}'],
  ['unsafe counter', `{"user-1":${Number.MAX_SAFE_INTEGER + 1}}`],
  ['infinite counter', '{"user-1":1e400}'],
  ['string counter', '{"user-1":"1"}'],
  ['null counter', '{"user-1":null}'],
  ['boolean counter', '{"user-1":true}'],
  ['object counter', '{"user-1":{}}'],
  ['array counter', '{"user-1":[]}'],
  ['invalid counter after a valid counter', '{"user-1":5,"user-2":-1}'],
]) {
  test(`persisted approval counters reject ${name} without rewriting state`, async (t) => {
    const dir = await makeTempDir('state-approval-corrupt')
    t.after(() => cleanup(dir))
    const file = join(dir, 'state', 'bot1.json')
    await mkdir(join(dir, 'state'), { recursive: true })
    const text = `{"version":1,"cursor":"keep-me","approvalCounters":${counters}}\n`
    await writeFile(file, text, 'utf8')

    const state = new ChannelState({ stateDir: dir, botId: 'bot1' })
    await assert.rejects(() => state.load(), /unexpected approval counters/)
    assert.equal(state.approvalCounters.size, 0)
    await state.flush()
    assert.equal(await readFile(file, 'utf8'), text)
  })
}

test('approval counter exhaustion throws without wrapping or changing persisted state', async (t) => {
  const dir = await makeTempDir('state-approvals')
  t.after(() => cleanup(dir))
  const file = join(dir, 'state', 'bot1.json')
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(file, JSON.stringify({
    version: 1,
    approvalCounters: { 'user-1': Number.MAX_SAFE_INTEGER - 1 },
  }))

  const state = await loadedState(dir)
  assert.equal(await state.nextApprovalId('user-1'), String(Number.MAX_SAFE_INTEGER))
  const text = await readFile(file, 'utf8')
  const results = await Promise.allSettled([
    state.nextApprovalId('user-1'),
    state.nextApprovalId('user-1'),
  ])
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected'])
  for (const result of results) assert.match(result.reason.message, /approval counter exhausted/)
  assert.equal(state.approvalCounters.get('user-1'), Number.MAX_SAFE_INTEGER)
  await state.flush()
  assert.equal(await readFile(file, 'utf8'), text)

  const reopened = await loadedState(dir)
  await assert.rejects(() => reopened.nextApprovalId('user-1'), /approval counter exhausted/)
  assert.equal(await reopened.nextApprovalId('user-2'), '1')
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.approvalCounters['user-1'], Number.MAX_SAFE_INTEGER)
})
