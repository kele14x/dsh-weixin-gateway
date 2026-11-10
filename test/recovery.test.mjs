import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gateway } from '../src/runtime.mjs'
import { AccountStore } from '../src/store/accounts.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { InboundJournal } from '../src/store/inbound.mjs'
import { normalizeInbound } from '../src/ilink/messages.mjs'
import { createLogger } from '../src/util/log.mjs'
import { FakeClient } from './helpers/fake-client.mjs'
import { FakeHost } from './helpers/fake-host.mjs'
import { cleanup, makeTempDir, waitFor } from './helpers/tmp.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const NOTICE = /gateway restarted without a saved completion/
const QUEUED = /queued message\(s\) were not submitted/
const SUBMITTED = /may already have run actions/

function message({ id = 1, from = 'u1', text = 'private task', context = 'ctx-1', group } = {}) {
  return {
    message_id: id, from_user_id: from, to_user_id: 'bot1', message_type: 1,
    ...(context === undefined ? {} : { context_token: context }),
    ...(group === undefined ? {} : { group_id: group }),
    item_list: [{ type: 1, text_item: { text } }],
  }
}

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function diskJournal(dir, botId = 'bot1') {
  const journal = new InboundJournal({ stateDir: dir, botId })
  await journal.load()
  return journal
}

async function diskState(dir, botId = 'bot1') {
  const state = new ChannelState({ stateDir: dir, botId })
  await state.load()
  return state
}

async function seed(dir, { id = 1, from = 'u1', phase = 'queued', context = 'journal-context', botId = 'bot1' } = {}) {
  const journal = await diskJournal(dir, botId)
  await journal.record(normalizeInbound(message({ id, from, context })))
  if (phase === 'submitting') await journal.markSubmitting(from, id)
  return journal
}

function open(t, fixture, { hostOptions = {}, config = {}, batches = [], logger } = {}) {
  const accounts = new AccountStore({ stateDir: fixture.dir })
  const host = new FakeHost(hostOptions)
  const client = new FakeClient({ batches })
  const stats = { polls: 0 }
  const poll = client.getUpdates.bind(client)
  client.getUpdates = (options) => { stats.polls += 1; return poll(options) }
  const gateway = new Gateway({
    config: { ...fixture.config, ...config }, host, accounts, clientFactory: () => client, logger,
  })
  fixture.gateways.push(gateway)
  return { ...fixture, gateway, accounts, host, client, stats }
}

async function fixture(t, options = {}) {
  const dir = await makeTempDir('recovery')
  const accounts = new AccountStore({ stateDir: dir })
  await accounts.save({ botId: 'bot1', botToken: 'fake-token', baseUrl: 'https://fake.test' })
  const allowed = new AllowList({ stateDir: dir })
  await allowed.load()
  await allowed.allow('u1')
  const base = {
    dir, gateways: [], releases: [],
    config: {
      stateDir: dir, defaultCwd: ROOT, baseUrl: 'https://fake.test', mediaEnabled: false,
      maxMessageChars: 1800, chunkDelayMs: 1, pollTimeoutMs: 100, queueLimit: 4,
      turnTimeoutMs: 5000, bindCodeEnv: '', replyMode: 'all', sessionPauseMs: 10,
      logLevel: 'silent', debugLogContent: false, botAgent: 'dsh-weixin/recovery-test',
    },
  }
  t.after(async () => {
    for (const release of base.releases) await release()
    try {
      for (const gateway of base.gateways) await gateway.stop()
    } finally {
      await cleanup(dir)
    }
  })
  return open(t, base, options)
}

function hold(fixture, value) {
  const pending = Promise.withResolvers()
  fixture.releases.push(() => pending.resolve(value))
  return pending
}

async function batch(fixture, msgs, cursor = 'accepted-batch') {
  fixture.client.push({ msgs, getUpdatesBuf: cursor })
  await waitFor(() => fixture.gateway.state.cursor === cursor, { message: `persisted cursor ${cursor}` })
}

function notice(client, { queued = false, submitted = false, count } = {}) {
  assert.equal(client.sent.length, 1, 'one aggregated notice, not one per message')
  const text = client.sent[0].text
  assert.match(text, NOTICE)
  assert.ok(text.includes('Nothing was replayed automatically.'))
  if (queued) assert.match(text, QUEUED)
  else assert.doesNotMatch(text, QUEUED)
  if (submitted) assert.match(text, SUBMITTED)
  else assert.doesNotMatch(text, SUBMITTED)
  if (count !== undefined) assert.ok(text.includes(`for ${count} message(s)`))
  assert.doesNotMatch(text, /private task|private queued|fake-token/)
}

// A directory blocks atomic rename even with elevated filesystem privileges.
async function blockJournal(fixture) {
  const file = fixture.gateway.inbound.file
  const saved = await readFile(file)
  await rm(file)
  await mkdir(file)
  let restored = false
  const restore = async () => {
    if (restored) return
    await rm(file, { recursive: true, force: true })
    await writeFile(file, saved, { mode: 0o600 })
    restored = true
  }
  fixture.releases.push(restore)
  return restore
}

test('host admission sees durable submitting metadata, accepted identity, and dedupe', async (t) => {
  const f = await fixture(t)
  await f.gateway.start()
  let accepted
  const record = f.gateway.inbound.record.bind(f.gateway.inbound)
  f.gateway.inbound.record = async (raw) => {
    assert.equal(f.gateway.state.hasSeen(raw.fromUserId, raw.messageId), false)
    const result = await record(raw)
    accepted = (await diskJournal(f.dir)).entries()[0]
    return result
  }
  const prompt = f.host.prompt.bind(f.host)
  let checkpoint
  f.host.prompt = async (options) => {
    checkpoint = {
      journal: await json(f.gateway.inbound.file),
      state: await diskState(f.dir),
      activeId: f.gateway.active.get('u1').messageId,
    }
    return prompt(options)
  }
  await batch(f, [message({ id: 42 })])
  assert.equal(await f.gateway.waitForQuiet(), true)
  assert.ok(checkpoint, 'the real Host prompt seam was reached')
  const [entry] = checkpoint.journal.entries
  assert.deepEqual(entry, { ...accepted, phase: 'submitting' })
  assert.equal(entry.messageId, '42')
  assert.equal(checkpoint.activeId, 42)
  assert.equal(checkpoint.state.hasSeen('u1', 42), true)
  assert.ok(Number.isSafeInteger(entry.acceptedAt))
  assert.deepEqual(Object.keys(entry).sort(), ['acceptedAt', 'contextToken', 'messageId', 'phase', 'userId'])
  assert.equal(JSON.stringify(checkpoint.journal).includes('private task'), false)
  assert.equal(f.client.sent[0].text, 'echo:private task')
})

test('routing, allowlist, attachment limits, and queue limits precede journaling', async (t) => {
  const f = await fixture(t, { hostOptions: { autoRespond: false }, config: { mediaEnabled: true, maxImagesPerMessage: 1, queueLimit: 1 } })
  await f.gateway.start()
  await batch(f, [message()])
  await waitFor(() => f.host.callsOf('prompt').length === 1)
  const images = message({ id: 7, text: '' })
  images.item_list = [{ type: 2, image_item: {} }, { type: 2, image_item: {} }]
  await batch(f, [
    message({ id: 2 }), message({ id: 3 }), message({ id: 4, from: 'stranger' }),
    message({ id: 5, group: 'group-secret' }), message({ id: 6, text: '/status' }), images,
  ], 'routing')
  const journal = await diskJournal(f.dir)
  assert.deepEqual(journal.entries().map((entry) => entry.messageId).sort(), ['1', '2'])
  assert.equal(f.host.callsOf('prompt').length, 1)
  assert.equal(f.client.sent.some((sent) => /Please wait/.test(sent.text)), true)
  assert.equal(f.client.sent.some((sent) => /not paired/.test(sent.text)), true)
  assert.equal(f.client.sent.some((sent) => /Too many images/.test(sent.text)), true)
  assert.equal(f.gateway.state.hasSeen('u1', 5), false, 'ignored group traffic is not accepted')
  assert.equal(f.client.sent.some((sent) => sent.text.includes('group-secret')), false)
})

test('graceful restart aggregates active and queued work, skips redelivery, and accepts only new prompts', async (t) => {
  const f = await fixture(t, { hostOptions: { autoRespond: false } })
  await f.gateway.start()
  await batch(f, [message()])
  await waitFor(() => f.host.callsOf('prompt').length === 1)
  await batch(f, [message({ id: 2, text: 'private queued', context: 'ctx-2' })], 'queued')
  assert.deepEqual((await diskJournal(f.dir)).entries().map((entry) => entry.phase), ['submitting', 'queued'])
  await f.gateway.stop()
  assert.equal(f.client.sent.length, 0, 'shutdown never sends interruption notices')
  assert.equal((await diskJournal(f.dir)).entries().length, 2)
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { queued: true, submitted: true, count: 2 })
  assert.equal(next.client.sent[0].contextToken, 'ctx-2')
  assert.equal(next.host.callsOf('create').length, 0)
  assert.equal(next.host.callsOf('prompt').length, 0)
  const recovered = await diskState(f.dir)
  assert.equal(recovered.hasSeen('u1', 1), true)
  assert.equal(recovered.hasSeen('u1', 2), true)
  await batch(next, [message(), message({ id: 2 })], 'redelivery')
  assert.equal(await next.gateway.waitForQuiet(), true)
  assert.equal(next.host.callsOf('prompt').length, 0)
  assert.equal(next.client.sent.length, 1)
  await batch(next, [message({ id: 3, text: 'new work' })], 'fresh')
  assert.equal(await next.gateway.waitForQuiet(), true)
  assert.equal(next.host.callsOf('prompt').length, 1)
  assert.equal(next.host.callsOf('create').length, 0, 'the saved session is reused, not reconstructed')
  assert.equal(next.client.sent[1].text, 'echo:new work')
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  await next.gateway.stop()
  const clean = open(t, f)
  await clean.gateway.start()
  assert.deepEqual(clean.client.sent, [])
  assert.equal(clean.host.callsOf('prompt').length, 0)
})

for (const stage of ['preparation', 'pending admission']) {
  test(`restart distinguishes queued ${stage} from potentially submitted work`, async (t) => {
    const f = await fixture(t)
    const pending = hold(f, 'delayed-session')
    if (stage === 'preparation') f.host.createSession = () => pending.promise
    else {
      const prompt = f.host.prompt.bind(f.host)
      f.host.autoRespond = false
      f.host.prompt = async (options) => { await prompt(options); await pending.promise }
    }
    await f.gateway.start()
    await batch(f, [message(), message({ id: 2 })])
    await waitFor(() => stage === 'preparation' ? f.gateway.router.inflight.size === 1 : f.host.callsOf('prompt').length === 1)
    const entries = (await diskJournal(f.dir)).entries()
    assert.equal(entries[0].phase, stage === 'preparation' ? 'queued' : 'submitting')
    assert.equal(entries[1].phase, 'queued')
    const stopping = f.gateway.stop()
    pending.resolve('delayed-session')
    await stopping
    assert.deepEqual(f.client.sent, [])
    const next = open(t, f)
    await next.gateway.start()
    notice(next.client, { queued: true, submitted: stage !== 'preparation', count: 2 })
    assert.equal(next.host.callsOf('prompt').length, 0)
  })
}

for (const failedSend of [false, true]) {
  test(`terminal completion is removed before ${failedSend ? 'a failed' : 'a successful'} answer send and never replayed`, async (t) => {
    const f = await fixture(t)
    let beforeSend
    const send = f.client.sendMessage.bind(f.client)
    f.client.sendMessage = async (options) => {
      beforeSend = (await diskJournal(f.dir)).entries()
      return send(options)
    }
    if (failedSend) f.client.failNextSends = 2
    await f.gateway.start()
    await batch(f, [message()])
    assert.equal(await f.gateway.waitForQuiet(), true)
    assert.deepEqual(beforeSend, [])
    assert.equal(f.client.sent.length, failedSend ? 0 : 1)
    await f.gateway.stop()
    const next = open(t, f)
    await next.gateway.start()
    assert.deepEqual(next.client.sent, [])
    await batch(next, [message()], 'redelivery')
    assert.equal(await next.gateway.waitForQuiet(), true)
    assert.equal(next.host.callsOf('prompt').length, 0)
    assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  })
}

test('failed startup notice sends keep metadata for the next startup', async (t) => {
  const f = await fixture(t)
  await seed(f.dir, { phase: 'submitting' })
  await seed(f.dir, { id: 2 })
  f.client.failNextSends = 2
  await f.gateway.start()
  assert.deepEqual(f.client.sent, [])
  assert.equal(f.gateway.interrupted.size, 2)
  assert.equal((await diskJournal(f.dir)).entries().length, 2)
  assert.equal((await diskState(f.dir)).hasSeen('u1', 2), true)
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { queued: true, submitted: true })
  assert.equal(next.host.callsOf('prompt').length, 0)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
})

test('a duplicate incoming message retries a failed notice with fresh context before dedupe', async (t) => {
  const f = await fixture(t)
  await seed(f.dir, { phase: 'submitting' })
  f.client.failNextSends = 2
  await f.gateway.start()
  await batch(f, [message({ context: 'fresh-context' })])
  notice(f.client, { submitted: true })
  assert.equal(f.client.sent[0].contextToken, 'fresh-context')
  assert.equal(f.host.callsOf('prompt').length, 0)
  assert.equal(f.gateway.interrupted.size, 0)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  await batch(f, [message({ id: 2, text: 'new work' })], 'new-work')
  assert.equal(await f.gateway.waitForQuiet(), true)
  assert.equal(f.host.callsOf('prompt').length, 1)
  assert.equal(f.client.sent[1].text, 'echo:new work')
})

for (const existingContext of [false, true]) {
  test(`startup ${existingContext ? 'preserves newer channel context instead of' : 'uses'} journal context fallback`, async (t) => {
    const f = await fixture(t)
    await seed(f.dir)
    if (existingContext) await (await diskState(f.dir)).setContextToken('u1', 'newer-state-context')
    await f.gateway.start()
    notice(f.client, { queued: true })
    const expected = existingContext ? 'newer-state-context' : 'journal-context'
    assert.equal(f.client.sent[0].contextToken, expected)
    assert.equal((await diskState(f.dir)).contextTokenFor('u1'), expected)
    assert.equal(f.host.callsOf('prompt').length, 0)
  })
}

test('missing context retains the notice until a fresh message supplies it', async (t) => {
  const f = await fixture(t)
  await seed(f.dir, { context: '' })
  await f.gateway.start()
  assert.deepEqual(f.client.sent, [])
  assert.equal(f.gateway.inbound.has('u1', 1), true)
  await batch(f, [message({ text: '/status', context: 'now-deliverable' })])
  notice(f.client, { queued: true })
  assert.equal(f.client.sent[0].contextToken, 'now-deliverable')
  assert.equal(f.host.callsOf('prompt').length, 0)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
})

test('revoked senders receive no recovery notice and group traffic cannot retry or leak one', async (t) => {
  const f = await fixture(t)
  const allowed = new AllowList({ stateDir: f.dir })
  await allowed.load()
  await allowed.allow('revoked')
  await seed(f.dir, { from: 'revoked', context: 'revoked-secret', phase: 'submitting' })
  await allowed.revoke('revoked')
  await seed(f.dir, { context: 'direct-secret' })
  f.client.failNextSends = 2
  await f.gateway.start()
  assert.equal(f.gateway.inbound.has('revoked', 1), false)
  assert.equal(f.gateway.inbound.has('u1', 1), true)
  await batch(f, [message({ id: 2, group: 'private-group', context: 'group-secret' })])
  assert.deepEqual(f.client.sent, [])
  assert.equal(f.gateway.state.contextTokenFor('u1'), 'direct-secret')
  assert.equal(f.gateway.inbound.has('u1', 2), false)
  assert.equal(f.host.callsOf('prompt').length, 0)
  await batch(f, [message({ context: 'new-direct' })], 'direct')
  notice(f.client, { queued: true })
  assert.equal(f.client.sent[0].toUserId, 'u1')
  assert.doesNotMatch(f.client.sent[0].text, /revoked|private-group|secret/)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
})

test('recovery and dedupe stay isolated to the selected account', async (t) => {
  const f = await fixture(t)
  const firstJournal = await seed(f.dir, { context: 'bot1-context' })
  await f.accounts.save({ botId: 'bot2', botToken: 'other-fake-token', baseUrl: 'https://fake.test' })
  await seed(f.dir, { botId: 'bot2', phase: 'submitting', context: 'bot2-context' })
  await f.gateway.start()
  notice(f.client, { submitted: true })
  assert.equal(f.client.sent[0].contextToken, 'bot2-context')
  assert.equal((await diskJournal(f.dir, 'bot1')).entries().length, 1)
  assert.equal((await diskState(f.dir, 'bot1')).hasSeen('u1', 1), false)
  assert.notEqual(f.gateway.inbound.file, firstJournal.file)
  await f.gateway.stop()
  await f.accounts.save(await f.accounts.load('bot1'))
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { queued: true })
  assert.equal(next.client.sent[0].contextToken, 'bot1-context')
  assert.equal(next.host.callsOf('prompt').length, 0)
  assert.deepEqual((await diskJournal(f.dir, 'bot2')).entries(), [])
})

test('corrupt inbound tracking fails closed before transport, polling, or observers', async (t) => {
  const f = await fixture(t)
  const journal = await seed(f.dir)
  const valid = await json(journal.file)
  for (const contents of ['{broken-json', JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], phase: 'completed' }] })]) {
    await writeFile(journal.file, contents)
    const next = open(t, f)
    await assert.rejects(() => next.gateway.start(), /not valid JSON|Invalid inbound message tracking/)
    assert.equal(next.gateway.status, 'error')
    assert.equal(next.stats.polls, 0)
    assert.equal(next.gateway.client, undefined)
    assert.equal(next.host.listeners.size, 0)
    assert.equal(next.host.approvalListeners.size, 0)
    assert.deepEqual(next.client.notifications, [])
    assert.equal(await readFile(journal.file, 'utf8'), contents)
    await next.gateway.stop()
  }
})

test('failed acceptance persistence stops before dedupe, cursor advancement, or dispatch', async (t) => {
  const f = await fixture(t)
  await f.gateway.start()
  await f.gateway.state.setCursor('before-failure')
  await f.gateway.inbound.record(normalizeInbound(message({ id: 'previous' })))
  const restore = await blockJournal(f)
  f.client.push({ msgs: [message(), message({ id: 2 })], getUpdatesBuf: 'must-not-advance' })
  await waitFor(() => f.gateway.status === 'error')
  assert.equal(f.gateway.abort.signal.aborted, true)
  assert.equal(f.gateway.state.cursor, 'before-failure')
  assert.equal((await diskState(f.dir)).cursor, 'before-failure')
  assert.equal(f.gateway.state.hasSeen('u1', 1), false)
  assert.equal((await diskState(f.dir)).hasSeen('u1', 1), false)
  assert.equal(f.gateway.inbound.has('u1', 1), false)
  assert.equal(f.gateway.inbound.has('u1', 'previous'), true)
  assert.equal(f.host.callsOf('create').length, 0)
  assert.equal(f.host.callsOf('prompt').length, 0)
  assert.deepEqual(f.client.sent, [])
  await restore()
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { queued: true, count: 1 })
})

test('failed submission tracking retains accepted work even after the cursor advances', async (t) => {
  const f = await fixture(t)
  await f.gateway.start()
  const checkpoint = hold(f)
  const setCursor = f.gateway.state.setCursor.bind(f.gateway.state)
  f.gateway.state.setCursor = async (cursor) => {
    assert.equal((await diskJournal(f.dir)).entries()[0].phase, 'queued')
    await setCursor(cursor)
    checkpoint.resolve()
  }
  const submitting = f.gateway.inbound.markSubmitting.bind(f.gateway.inbound)
  let restore
  f.gateway.inbound.markSubmitting = async (...args) => {
    await checkpoint.promise
    restore = await blockJournal(f)
    return submitting(...args)
  }
  f.client.push({ msgs: [message()], getUpdatesBuf: 'submission-batch' })
  await waitFor(() => f.gateway.status === 'error')
  assert.equal(f.gateway.abort.signal.aborted, true)
  assert.equal(f.host.callsOf('prompt').length, 0)
  assert.equal(f.gateway.inbound.entries()[0].phase, 'queued')
  assert.equal(f.gateway.state.hasSeen('u1', 1), true)
  const cursorAtFailure = (await diskState(f.dir)).cursor
  assert.deepEqual(f.client.sent, [])
  await restore()
  assert.equal((await diskJournal(f.dir)).entries()[0].phase, 'queued')
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { queued: true })
  assert.equal(next.host.callsOf('prompt').length, 0)
  assert.equal(cursorAtFailure, 'submission-batch', 'the accepted record remains recoverable after cursor advancement')
})

test('failed completion removal logs but sends the true answer and retains a conservative notice', async (t) => {
  const logs = []
  const logger = createLogger({ level: 'debug', sink: { log: (line) => logs.push(line), error: (line) => logs.push(line) } })
  const f = await fixture(t, { hostOptions: { autoRespond: false }, logger })
  await f.gateway.start()
  await batch(f, [message()])
  await waitFor(() => f.host.callsOf('prompt').length === 1)
  const restore = await blockJournal(f)
  f.host.emitTurn({ ...f.host.callsOf('prompt')[0], text: 'actual completed work' })
  await waitFor(() => f.client.sent.length === 1)
  assert.equal(await f.gateway.waitForQuiet(), true)
  assert.equal(f.client.sent[0].text, 'echo:actual completed work')
  assert.match(logs.join('\n'), /could not record inbound completion/)
  assert.equal(f.gateway.inbound.has('u1', 1), true)
  await restore()
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  notice(next.client, { submitted: true })
  assert.equal(next.host.callsOf('prompt').length, 0)
})

for (const failedCancellation of [false, true]) {
  test(`timeout ${failedCancellation ? 'with failed cancellation retains' : 'with handled cancellation removes'} inbound tracking`, async (t) => {
    const f = await fixture(t, { hostOptions: { autoRespond: false }, config: { turnTimeoutMs: 100 } })
    if (failedCancellation) f.host.cancel = () => { throw new Error('fake cancellation unavailable') }
    await f.gateway.start()
    await batch(f, [message()])
    await waitFor(() => f.client.sent.length === 1)
    if (failedCancellation) {
      assert.match(f.client.sent[0].text, /Cancellation failed/)
      assert.equal(f.gateway.active.get('u1').keepActive, true)
      assert.equal((await diskJournal(f.dir)).entries()[0].phase, 'submitting')
    } else {
      assert.equal(await f.gateway.waitForQuiet(), true)
      assert.match(f.client.sent[0].text, /Cancellation was requested/)
      assert.deepEqual((await diskJournal(f.dir)).entries(), [])
    }
    await f.gateway.stop()
    const next = open(t, f)
    await next.gateway.start()
    if (failedCancellation) notice(next.client, { submitted: true })
    else assert.deepEqual(next.client.sent, [])
    assert.equal(next.host.callsOf('prompt').length, 0)
  })
}

test('/stop also clears undelivered interruption notices from an earlier startup', async (t) => {
  const f = await fixture(t)
  await seed(f.dir, { phase: 'submitting' })
  f.client.failNextSends = 2
  await f.gateway.start()
  assert.equal(f.gateway.interrupted.size, 1)
  assert.equal(await f.gateway.stopTurn('u1'), 'Nothing is running.')
  assert.equal(f.gateway.interrupted.size, 0)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  assert.deepEqual(next.client.sent, [])
  assert.equal(next.host.callsOf('prompt').length, 0)
})

test('/stop cancels before awaiting persistence and purges only its work snapshot', async (t) => {
  const f = await fixture(t, { hostOptions: { autoRespond: false } })
  await f.gateway.start()
  await f.gateway.allowed.allow('u2')
  await batch(f, [message()])
  await waitFor(() => f.host.callsOf('prompt').length === 1)
  await batch(f, [message({ id: 2 }), message({ id: 3, from: 'u2' })], 'two-senders')
  await waitFor(() => f.host.callsOf('prompt').length === 2)
  const pending = hold(f)
  const remove = f.gateway.inbound.remove.bind(f.gateway.inbound)
  let held = false
  f.gateway.inbound.remove = async (keys) => {
    if (!held) { held = true; await pending.promise }
    return remove(keys)
  }
  const before = f.host.callsOf('cancel').length
  const stopping = f.gateway.stopTurn('u1')
  assert.equal(f.host.callsOf('cancel').length, before + 1, 'cancellation is synchronous before the first await')
  assert.equal(f.gateway.active.get('u1').controller.signal.aborted, true)
  await batch(f, [message({ id: 4, text: 'subsequent task' })], 'subsequent')
  await waitFor(() => f.host.callsOf('prompt').length === 3)
  pending.resolve()
  assert.match(await stopping, /Stopping/)
  const remaining = (await diskJournal(f.dir)).entries()
  assert.deepEqual(remaining.map((entry) => [entry.userId, entry.messageId]).sort(), [['u1', '4'], ['u2', '3']])
  assert.equal(f.gateway.active.has('u2'), true)
  await f.gateway.stopTurn('u1')
  await f.gateway.stopTurn('u2')
  assert.equal(await f.gateway.waitForQuiet(), true)
  assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  await f.gateway.stop()
  const next = open(t, f)
  await next.gateway.start()
  assert.deepEqual(next.client.sent, [])
  await batch(next, [message(), message({ id: 2 }), message({ id: 3, from: 'u2' }), message({ id: 4 })], 'stopped-redelivery')
  assert.equal(await next.gateway.waitForQuiet(), true)
  assert.equal(next.host.callsOf('prompt').length, 0, 'explicitly stopped work cannot resurrect')
})

function crashScript() {
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href)
  return `
    import { readFile } from 'node:fs/promises';
    import { Gateway } from ${url('../src/runtime.mjs')};
    import { AccountStore } from ${url('../src/store/accounts.mjs')};
    import { FakeClient } from ${url('./helpers/fake-client.mjs')};
    import { FakeHost } from ${url('./helpers/fake-host.mjs')};
    const dir = process.env.RECOVERY_TEST_DIR;
    const phase = process.env.RECOVERY_TEST_PHASE;
    const ready = Promise.withResolvers();
    const seam = Promise.withResolvers();
    const messages = [1, 2].map((id) => ({
      message_id: id, from_user_id: 'u1', message_type: 1, context_token: 'child-context',
      item_list: [{ type: 1, text_item: { text: 'private task ' + id } }],
    }));
    const client = new FakeClient({ batches: [{ msgs: messages, getUpdatesBuf: 'crash-checkpoint' }] });
    const poll = client.getUpdates.bind(client);
    client.getUpdates = async (options) => { await ready.promise; return poll(options); };
    const host = new FakeHost({ autoRespond: false });
    if (phase === 'queued') {
      host.createSession = async () => { seam.resolve(); return new Promise(() => {}); };
    } else {
      const prompt = host.prompt.bind(host);
      host.prompt = async (options) => { await prompt(options); seam.resolve(); };
    }
    const gateway = new Gateway({
      config: { ...${JSON.stringify({ defaultCwd: ROOT, baseUrl: 'https://fake.test', mediaEnabled: false, maxMessageChars: 1800, chunkDelayMs: 1, pollTimeoutMs: 100, queueLimit: 4, turnTimeoutMs: 60000, bindCodeEnv: '', replyMode: 'all', sessionPauseMs: 10 })}, stateDir: dir },
      host, accounts: new AccountStore({ stateDir: dir }), clientFactory: () => client,
    });
    // IPC keeps the fake long poll alive; no temp helper or shutdown hook runs here.
    process.on('message', () => {});
    await gateway.start();
    const setCursor = gateway.state.setCursor.bind(gateway.state);
    gateway.state.setCursor = async (cursor) => {
      await setCursor(cursor);
      await seam.promise;
      const journal = JSON.parse(await readFile(gateway.inbound.file, 'utf8'));
      const state = JSON.parse(await readFile(gateway.state.file, 'utf8'));
      process.send({ type: 'checkpoint', journal, state, prompts: host.callsOf('prompt').length });
    };
    ready.resolve();
  `
}

async function hardKill(fixture, phase) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', crashScript()], {
    cwd: ROOT, env: { ...process.env, RECOVERY_TEST_DIR: fixture.dir, RECOVERY_TEST_PHASE: phase },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (text) => { stderr = (stderr + text).slice(-8192) })
  const signal = AbortSignal.timeout(10000)
  // Cleanup needs a fresh deadline after an IPC timeout.
  const exited = once(child, 'exit')
  exited.catch(() => {})
  const killAndReap = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return exited
    const reaped = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
    assert.equal(child.kill('SIGKILL'), true)
    return reaped
  }
  try {
    const [checkpoint] = await Promise.race([
      once(child, 'message', { signal }),
      exited.then(([code, exitSignal]) => { throw new Error(`child exited before checkpoint: ${code}/${exitSignal}`) }),
    ])
    assert.equal(checkpoint.type, 'checkpoint')
    assert.equal(checkpoint.state.cursor, 'crash-checkpoint', 'IPC follows the actual durable cursor write')
    assert.deepEqual(checkpoint.journal.entries.map((entry) => entry.phase), phase === 'queued' ? ['queued', 'queued'] : ['submitting', 'queued'])
    assert.equal(checkpoint.prompts, phase === 'queued' ? 0 : 1)
    const lock = await json(join(fixture.dir, 'lock', 'bot1.lock'))
    assert.equal(lock.pid, child.pid, 'only the child owns the crash fixture lock')
    const [code, exitSignal] = await killAndReap()
    assert.equal(code, null)
    assert.equal(exitSignal, 'SIGKILL')
    return checkpoint
  } catch (cause) {
    throw new Error(`hard-kill ${phase} fixture failed; child stderr: ${stderr || '(empty)'}`, { cause })
  } finally {
    try {
      await killAndReap()
    } finally {
      child.stderr.destroy()
    }
  }
}

for (const phase of ['queued', 'submitting']) {
  test(`SIGKILL recovery of durable ${phase} work uses real stores and recovers the dead child lock without redelivery`, async (t) => {
    const f = await fixture(t)
    await hardKill(f, phase)
    const journal = await diskJournal(f.dir)
    const state = await diskState(f.dir)
    assert.deepEqual(journal.entries().map((entry) => entry.messageId), ['1', '2'])
    assert.equal(state.cursor, 'crash-checkpoint')
    assert.equal(state.hasSeen('u1', 1), true)
    assert.equal(state.hasSeen('u1', 2), true)
    const next = open(t, f)
    await next.gateway.start()
    assert.equal(next.gateway.status, 'running', 'dead child ownership is reclaimed immediately')
    assert.equal((await json(join(f.dir, 'lock', 'bot1.lock'))).pid, process.pid)
    notice(next.client, { queued: true, submitted: phase === 'submitting', count: 2 })
    assert.equal(next.client.sent[0].contextToken, 'child-context')
    assert.equal(next.host.callsOf('create').length, 0)
    assert.equal(next.host.callsOf('prompt').length, 0)
    assert.equal(await next.gateway.waitForQuiet(), true)
    assert.equal(next.gateway.queues.size, 0)
    assert.equal(next.gateway.interrupted.size, 0)
    assert.deepEqual((await diskJournal(f.dir)).entries(), [])
  })
}
