import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Gateway } from '../src/runtime.mjs'
import { AccountStore } from '../src/store/accounts.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { acquireLock, LockError } from '../src/store/lock.mjs'
import { createLogger } from '../src/util/log.mjs'
import { FakeClient } from './helpers/fake-client.mjs'
import { FakeHost } from './helpers/fake-host.mjs'
import { cleanup, makeTempDir, waitFor } from './helpers/tmp.mjs'

/**
 * Build one gateway over real stores and fake transport/host.
 *
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [options] - setup options.
 * @returns {Promise<object>} fixture.
 */
async function setup(
  t,
  { msgs = [], config = {}, hostOptions = {}, allowed = true, account = true, gatewayOptions = {} } = {},
) {
  const dir = await makeTempDir('gw')
  t.after(() => cleanup(dir))

  const accounts = new AccountStore({ stateDir: dir })
  if (account) {
    await accounts.save({ botId: 'bot1', botToken: 'tok', baseUrl: 'https://fake.test', ownerUserId: 'owner' })
  }
  if (allowed) {
    const list = new AllowList({ stateDir: dir })
    await list.load()
    await list.allow('u1')
  }

  const client = new FakeClient({
    batches: msgs.length > 0 ? [{ msgs, getUpdatesBuf: 'cursor-1' }] : [],
  })
  const host = new FakeHost(hostOptions)
  const settings = {
    stateDir: dir,
    defaultCwd: process.cwd(),
    maxMessageChars: 1800,
    chunkDelayMs: 1,
    pollTimeoutMs: 100,
    queueLimit: 4,
    turnTimeoutMs: 1000,
    bindCodeEnv: 'DSH_WEIXIN_BIND_CODE',
    replyMode: 'all',
    sessionPauseMs: 10,
    logLevel: 'silent',
    debugLogContent: false,
    baseUrl: 'https://fake.test',
    botAgent: 'dsh-weixin/test',
    ...config,
  }
  const gateway = new Gateway({
    config: settings,
    host,
    logger: createLogger({ level: 'silent' }),
    accounts,
    clientFactory: () => client,
    ...gatewayOptions,
  })
  t.after(async () => {
    await gateway.stop()
  })
  return { dir, accounts, client, host, gateway, config: settings }
}

/**
 * Build one inbound text message.
 *
 * @param {object} [options] - message fields.
 * @returns {object} raw iLink message.
 */
function textMessage({ id = 1, from = 'u1', text = 'hello', context = 'ctx-1' } = {}) {
  return {
    message_id: id,
    from_user_id: from,
    to_user_id: 'bot',
    message_type: 1,
    context_token: context,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }],
  }
}

test('a paired text message creates one session and replies with the assistant text', async (t) => {
  const { dir, client, host, gateway } = await setup(t, { msgs: [textMessage()] })
  await gateway.start()
  assert.equal(gateway.status, 'running')

  await waitFor(() => client.sent.length > 0, { message: 'reply' })

  assert.equal(host.callsOf('create').length, 1)
  assert.equal(host.callsOf('prompt').length, 1)
  assert.equal(host.callsOf('prompt')[0].text, 'hello')
  assert.equal(client.sent[0].text, 'echo:hello')
  assert.equal(client.sent[0].contextToken, 'ctx-1')

  const state = new ChannelState({ stateDir: dir, botId: 'bot1' })
  await state.load()
  assert.equal(state.sessionFor('u1')?.sessionId, 'sess-1')
})

test('a second message reuses the stored session', async (t) => {
  const { client, host, gateway } = await setup(t, { msgs: [textMessage()] })
  await gateway.start()
  await waitFor(() => client.sent.length === 1, { message: 'first reply' })

  client.push({ msgs: [textMessage({ id: 2, text: 'again' })] })
  await waitFor(() => client.sent.length === 2, { message: 'second reply' })

  assert.equal(host.callsOf('create').length, 1)
  assert.equal(host.callsOf('prompt').length, 2)
})

test('a duplicated message id is processed once', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [textMessage({ id: 5 }), textMessage({ id: 5 })],
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'reply' })
  await delay(50)

  assert.equal(host.callsOf('prompt').length, 1)
  assert.equal(client.sent.length, 1)
})

test('an unpaired sender is denied and told how to pair', async (t) => {
  const { client, host, gateway } = await setup(t, {
    allowed: false,
    msgs: [textMessage({ from: 'u2', text: 'hello' })],
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'hint' })

  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /not paired/)
})

test('an unpaired sender can bind with the configured code', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'pair-me'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { client, gateway } = await setup(t, {
    allowed: false,
    msgs: [textMessage({ from: 'u2', text: '/bind pair-me' })],
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'bind reply' })

  assert.match(client.sent[0].text, /Paired/)
})

test('/new creates a second session and keeps the first', async (t) => {
  const { client, host, gateway } = await setup(t, { msgs: [textMessage({ id: 1 })] })
  await gateway.start()
  await waitFor(() => client.sent.length === 1, { message: 'first reply' })

  client.push({ msgs: [textMessage({ id: 2, text: '/new' })] })
  await waitFor(() => host.created === 2, { message: 'second session' })
  await waitFor(() => client.sent.length === 2, { message: 'new reply' })

  assert.match(client.sent[1].text, /new DSH session/)
})

test('/stop cancels the active turn, clears the queue, and stays quiet when it ends', async (t) => {
  const { client, host, gateway } = await setup(t, { hostOptions: { autoRespond: false } })
  await gateway.start()

  client.push({ msgs: [textMessage({ id: 1, text: 'long task' })] })
  await waitFor(() => host.callsOf('prompt').length === 1, { message: 'prompt' })
  const prompt = host.callsOf('prompt')[0]

  host.emit(prompt.sessionId, { type: 'turn/start', data: { turn: 1 } })
  host.emit(prompt.sessionId, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: prompt.requestId }, content: [] },
  })

  client.push({ msgs: [textMessage({ id: 2, text: '/stop' })] })
  await waitFor(() => host.callsOf('cancel').length === 1, { message: 'cancel' })
  assert.match(client.sent.at(-1).text, /Stopping/)

  const before = client.sent.length
  host.emit(prompt.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  await delay(50)
  assert.equal(client.sent.length, before, 'aborted notice must be suppressed after /stop')
})

test('a long reply is chunked under the configured limit', async (t) => {
  const long = 'x'.repeat(4000)
  const { client, gateway } = await setup(t, {
    msgs: [textMessage({ text: 'long please' })],
    hostOptions: { reply: () => long },
  })
  await gateway.start()
  await waitFor(() => client.sent.length >= 3, { message: 'chunks' })

  for (const message of client.sent) assert.ok(message.text.length <= 1800)
  assert.equal(client.sent.map((message) => message.text).join(''), long)
})

test('a retry after a lost acknowledgement reuses the chunk client id', async (t) => {
  const { client, gateway } = await setup(t, {
    msgs: [textMessage()],
    hostOptions: { reply: () => 'part one\npart two' },
    config: { maxMessageChars: 10 },
  })
  client.loseNextAcks = 1
  await gateway.start()
  await waitFor(() => client.sent.length === 3, { message: 'retry and second chunk' })

  const [first, retry, second] = client.sent
  assert.equal(first.text, 'part one')
  assert.equal(retry.text, 'part one')
  assert.equal(typeof first.clientId, 'string')
  assert.equal(retry.clientId, first.clientId)
  assert.equal(second.text, 'part two')
  assert.notEqual(second.clientId, first.clientId)
})

test('a completed turn without text still produces a notice', async (t) => {
  const { client, gateway } = await setup(t, {
    msgs: [textMessage()],
    hostOptions: { reply: () => '' },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'notice' })
  assert.match(client.sent[0].text, /without text output/)
})

test('a media-only message is answered with a text-only notice', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [
      {
        message_id: 9,
        from_user_id: 'u1',
        message_type: 1,
        context_token: 'ctx',
        item_list: [{ type: 2, image_item: { mid_size: 10 } }],
      },
    ],
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'notice' })

  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /Only text messages/)
})

test('a second gateway on the same account refuses to poll', async (t) => {
  const { config, host } = await setup(t)
  const first = new Gateway({
    config,
    host,
    logger: createLogger({ level: 'silent' }),
    clientFactory: () => new FakeClient(),
  })
  t.after(() => first.stop())
  await first.start()
  assert.equal(first.status, 'running')

  const second = new Gateway({
    config,
    host,
    logger: createLogger({ level: 'silent' }),
    accounts: new AccountStore({ stateDir: config.stateDir }),
    clientFactory: () => new FakeClient(),
  })
  t.after(() => second.stop())
  await second.start()
  assert.equal(second.status, 'locked')
})

test('a locked gateway adopts the account once the first owner exits', async (t) => {
  const { config, host } = await setup(t)
  const first = new Gateway({
    config,
    host,
    logger: createLogger({ level: 'silent' }),
    clientFactory: () => new FakeClient(),
  })
  t.after(() => first.stop())
  await first.start()
  assert.equal(first.status, 'running')

  const second = new Gateway({
    config,
    host,
    logger: createLogger({ level: 'silent' }),
    accounts: new AccountStore({ stateDir: config.stateDir }),
    clientFactory: () => new FakeClient(),
    lockRetryMs: 20,
  })
  t.after(() => second.stop())
  await second.start()
  assert.equal(second.status, 'locked')

  await first.stop()
  await waitFor(() => second.status === 'running', { message: 'the second gateway adopted the account' })
})

test('a missing credential disables the channel with a diagnostic', async (t) => {
  const { gateway } = await setup(t, { account: false })
  await gateway.start()
  assert.equal(gateway.status, 'unconfigured')
})

test('a -14 response pauses and then resumes polling', async (t) => {
  const { client, gateway } = await setup(t)
  client.pausedOnce = 'pending'
  await gateway.start()

  await waitFor(() => client.pausedOnce === 'done', { message: 'pause observed' })
  await waitFor(() => gateway.status === 'running', { message: 'resumed' })
})

test('a -14 pause keeps the poller lock warm', async (t) => {
  const { client, gateway } = await setup(t, {
    config: { sessionPauseMs: 200 },
    gatewayOptions: { pauseHeartbeatMs: 10 },
  })
  await gateway.start()
  await waitFor(() => gateway.status === 'running', { message: 'running' })

  let touches = 0
  const realTouch = gateway.lock.touch.bind(gateway.lock)
  gateway.lock.touch = async () => {
    touches += 1
    return realTouch()
  }

  client.pausedOnce = 'pending'
  client.push({ msgs: [] })

  await waitFor(() => client.pausedOnce === 'done', { message: 'pause observed' })
  await waitFor(() => gateway.status === 'running', { message: 'resumed' })
  assert.ok(touches >= 5, `expected repeated lock heartbeats during the pause, saw ${touches}`)
})

test('a failed command does not skip later messages in its batch', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [textMessage({ id: 1, text: '/new' }), textMessage({ id: 2, text: 'hello' })],
  })
  const create = host.createSession.bind(host)
  let attempts = 0
  host.createSession = async (options) => {
    if (attempts++ === 0) throw new Error('creation failed')
    return create(options)
  }
  await gateway.start()
  await waitFor(() => client.sent.length === 2 && gateway.state.cursor === 'cursor-1')
  assert.match(client.sent[0].text, /Could not process this message: creation failed/)
  assert.equal(client.sent[1].text, 'echo:hello')
  assert.equal(host.callsOf('prompt').length, 1)
})

test('a batch cursor is not saved while a command is still pending', async (t) => {
  const { dir, client, host, gateway } = await setup(t)
  const creation = Promise.withResolvers()
  t.after(() => creation.resolve('delayed-session'))
  host.createSession = () => creation.promise
  await gateway.start()
  await gateway.state.setCursor('before')
  client.push({ msgs: [textMessage({ text: '/new' })], getUpdatesBuf: 'after' })
  await waitFor(() => gateway.router.inflight.size === 1)
  assert.equal(gateway.state.cursor, 'before')
  assert.equal(JSON.parse(await readFile(join(dir, 'state', 'bot1.json'), 'utf8')).cursor, 'before')
  creation.resolve('delayed-session')
  await waitFor(() => gateway.state.cursor === 'after')
})

test('shutdown leaves a partially handled batch cursor unchanged', async (t) => {
  const { client, host, gateway } = await setup(t)
  const creation = Promise.withResolvers()
  t.after(() => creation.resolve('delayed-session'))
  host.createSession = () => creation.promise
  await gateway.start()
  await gateway.state.setCursor('before')
  client.push({
    msgs: [textMessage({ id: 1, text: '/new' }), textMessage({ id: 2, text: 'must not run' })],
    getUpdatesBuf: 'after',
  })
  await waitFor(() => gateway.router.inflight.size === 1)
  const stopping = gateway.stop()
  creation.resolve('delayed-session')
  await stopping
  assert.equal(gateway.state.cursor, 'before')
  assert.equal(host.callsOf('prompt').length, 0)
})

test('a timed-out turn requests Host cancellation and reports it accurately', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [textMessage()],
    config: { turnTimeoutMs: 30 },
    hostOptions: { autoRespond: false },
  })
  await gateway.start()
  await waitFor(() => client.sent.length === 1)
  assert.equal(host.callsOf('cancel').length, 1)
  assert.match(client.sent[0].text, /Cancellation was requested/)
  assert.doesNotMatch(client.sent[0].text, /send \/stop/)
  assert.equal(await gateway.waitForQuiet(), true)
})

test('a failed timeout cancellation retains the handle for a later stop', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [textMessage()],
    config: { turnTimeoutMs: 30 },
    hostOptions: { autoRespond: false },
  })
  const cancel = host.cancel.bind(host)
  let attempts = 0
  host.cancel = (options) => {
    if (attempts++ === 0) throw new Error('cancel failed')
    cancel(options)
  }
  await gateway.start()
  await waitFor(() => client.sent.length === 1)
  assert.match(client.sent[0].text, /Cancellation failed; send \/stop/)
  assert.equal(gateway.active.size, 1)
  client.push({ msgs: [textMessage({ id: 2, text: 'queued' })] })
  await waitFor(() => gateway.queues.has('u1'))
  assert.equal(host.callsOf('prompt').length, 1)
  assert.match(gateway.stopTurn('u1'), /Stopping/)
  assert.equal(host.callsOf('cancel').length, 1)
  assert.equal(gateway.active.size, 0)
  assert.equal(gateway.queues.size, 0)
})

for (const stage of ['getConfig', 'sendTyping', 'createSession']) {
  test(`/stop during ${stage} prevents later prompt admission`, async (t) => {
    const { client, host, gateway } = await setup(t)
    const pending = Promise.withResolvers()
    t.after(() => pending.resolve(stage === 'getConfig' ? { typingTicket: 'ticket' } : 'delayed-session'))
    let entered = false
    const target = stage === 'createSession' ? host : client
    target[stage] = () => {
      entered = true
      return pending.promise
    }
    await gateway.start()
    client.push({ msgs: [textMessage()] })
    await waitFor(() => entered)
    assert.match(gateway.stopTurn('u1'), /Stopping/)
    pending.resolve(stage === 'getConfig' ? { typingTicket: 'ticket' } : 'delayed-session')
    assert.equal(await gateway.waitForQuiet(), true)
    assert.equal(host.callsOf('prompt').length, 0)
    assert.equal(host.callsOf('cancel').length, 0)
  })
}

test('a cancelled pending admission cannot cancel a later prompt in the same session', async (t) => {
  const { client, host, gateway } = await setup(t)
  const admission = Promise.withResolvers()
  t.after(() => admission.resolve())
  const prompt = host.prompt.bind(host)
  let attempts = 0
  host.prompt = async (options) => {
    if (attempts++ === 0) {
      host.calls.push({ type: 'prompt', ...options })
      await admission.promise
      return
    }
    return prompt(options)
  }
  await gateway.start()
  client.push({ msgs: [textMessage()] })
  await waitFor(() => host.callsOf('prompt').length === 1)
  assert.match(gateway.stopTurn('u1'), /Stopping/)
  client.push({ msgs: [textMessage({ id: 2, text: 'later', context: 'ctx-2' })] })
  await waitFor(() => gateway.state.contextTokenFor('u1') === 'ctx-2')
  await delay(20)
  assert.equal(host.callsOf('prompt').length, 1, 'new admission must wait for the cancelled admission to settle')
  admission.resolve()
  await waitFor(() => host.callsOf('prompt').length === 2)
  assert.equal(await gateway.waitForQuiet(), true)
  assert.equal(host.callsOf('cancel').length, 2)
  assert.equal(client.sent.at(-1).text, 'echo:later')
})

test('a failed late-admission cancellation keeps a usable stop handle', async (t) => {
  const { client, host, gateway } = await setup(t)
  const admission = Promise.withResolvers()
  t.after(() => admission.resolve())
  host.prompt = async (options) => {
    host.calls.push({ type: 'prompt', ...options })
    await admission.promise
  }
  const cancel = host.cancel.bind(host)
  let attempts = 0
  host.cancel = (options) => {
    if (++attempts === 2) throw new Error('late cancellation failed')
    cancel(options)
  }
  await gateway.start()
  client.push({ msgs: [textMessage()] })
  await waitFor(() => host.callsOf('prompt').length === 1)
  assert.match(gateway.stopTurn('u1'), /Stopping/)
  admission.resolve()
  await waitFor(() => gateway.draining.size === 0)
  assert.equal(gateway.active.get('u1')?.keepActive, true)
  assert.match(gateway.stopTurn('u1'), /Stopping/)
  assert.equal(gateway.active.size, 0)
  assert.equal(attempts, 3)
})

test('completed output cannot bypass an unresolved admission', async (t) => {
  const { client, host, gateway } = await setup(t)
  const admission = Promise.withResolvers()
  t.after(() => admission.resolve())
  const prompt = host.prompt.bind(host)
  let attempts = 0
  host.prompt = async (options) => {
    await prompt(options)
    if (attempts++ === 0) await admission.promise
  }
  await gateway.start()
  client.push({ msgs: [textMessage()] })
  await waitFor(() => client.sent.length === 1)
  client.push({ msgs: [textMessage({ id: 2, text: 'later' })] })
  await waitFor(() => gateway.queues.has('u1'))
  assert.equal(host.callsOf('prompt').length, 1)
  admission.resolve()
  await waitFor(() => client.sent.length === 2)
  assert.equal(await gateway.waitForQuiet(), true)
  assert.equal(host.callsOf('cancel').length, 0)
})

for (const stage of ['getConfig', 'sendTyping']) {
  test(`turn timeout covers a pending ${stage} request before admission`, async (t) => {
    const { client, host, gateway } = await setup(t, { config: { turnTimeoutMs: 30 } })
    const typing = Promise.withResolvers()
    t.after(() => typing.resolve({ typingTicket: 'ticket' }))
    client[stage] = () => typing.promise
    await gateway.start()
    client.push({ msgs: [textMessage()] })
    await waitFor(() => client.sent.length === 1)
    assert.match(client.sent[0].text, /No prompt was submitted/)
    assert.equal(await gateway.waitForQuiet(), true)
    typing.resolve({ typingTicket: 'ticket' })
    await delay(20)
    assert.equal(host.callsOf('prompt').length, 0)
    assert.equal(host.callsOf('cancel').length, 0)
  })
}

for (const occupied of [false, true]) {
  test(`restart after ownership loss tears down the old generation before ${occupied ? 'lock refusal' : 'reacquisition'}`, async (t) => {
    const { config, client, host, gateway } = await setup(t)
    const admission = Promise.withResolvers()
    t.after(() => admission.resolve())
    host.prompt = async (options) => {
      host.calls.push({ type: 'prompt', ...options })
      await admission.promise
    }
    await gateway.start()
    client.push({ msgs: [textMessage()] })
    await waitFor(() => host.callsOf('prompt').length === 1)
    client.push({ msgs: [textMessage({ id: 2, text: 'old queue' })] })
    await waitFor(() => gateway.queues.has('u1'))
    if (occupied) {
      const { hostname } = await import('node:os')
      await writeFile(join(config.stateDir, 'lock', 'bot1.lock'), JSON.stringify({
        token: 'replacement', pid: process.pid, host: hostname(), heartbeat: Date.now(),
      }))
    } else {
      gateway.lock.touch = async () => { throw new LockError('ownership lost') }
    }
    client.push({ msgs: [] })
    await waitFor(() => gateway.status === 'error')
    const restarting = gateway.start()
    assert.equal(gateway.status, 'stopping')
    assert.equal(host.callsOf('prompt').length, 1)
    admission.resolve()
    await restarting
    assert.equal(gateway.status, occupied ? 'locked' : 'running')
    assert.equal(gateway.queues.size, 0)
    assert.equal(gateway.active.size, 0)
    assert.equal(host.listeners.size, occupied ? 0 : 1)
    await delay(20)
    assert.equal(host.callsOf('prompt').length, 1)
  })
}

test('shutdown cancels Host execution and disposes observers', async (t) => {
  const { host, gateway } = await setup(t, { msgs: [textMessage()], hostOptions: { autoRespond: false } })
  await gateway.start()
  await waitFor(() => host.callsOf('prompt').length === 1)
  await gateway.stop()
  assert.equal(host.callsOf('cancel').length, 1)
  assert.equal(host.listeners.size, 0)
  assert.equal(gateway.active.size, 0)
  assert.equal(gateway.drainPromises.size, 0)
  assert.equal(gateway.lock, undefined)
})

test('shutdown waits for session persistence before releasing ownership', async (t) => {
  const { config, client, host, gateway } = await setup(t)
  const creation = Promise.withResolvers()
  t.after(() => creation.resolve('delayed-session'))
  host.createSession = () => creation.promise
  await gateway.start()
  client.push({ msgs: [textMessage()] })
  await waitFor(() => gateway.router.inflight.size === 1)
  const stopping = gateway.stop()
  await assert.rejects(() => acquireLock(join(config.stateDir, 'lock', 'bot1.lock')), LockError)
  creation.resolve('delayed-session')
  await stopping
  assert.equal(host.callsOf('prompt').length, 0)
  assert.equal(gateway.state.sessionFor('u1').sessionId, 'delayed-session')
  const nextOwner = await acquireLock(join(config.stateDir, 'lock', 'bot1.lock'))
  await nextOwner.release()
})

test('an in-flight lock retry cannot restart polling after shutdown', async (t) => {
  const { config, accounts, client, gateway } = await setup(t, { gatewayOptions: { lockRetryMs: 10 } })
  const owner = await acquireLock(join(config.stateDir, 'lock', 'bot1.lock'))
  t.after(() => owner.release())
  const account = await accounts.latest()
  await gateway.start()
  assert.equal(gateway.status, 'locked')
  const lookup = Promise.withResolvers()
  t.after(() => lookup.resolve(account))
  accounts.latest = () => lookup.promise
  await waitFor(() => gateway.status === 'starting')
  await gateway.stop()
  await owner.release()
  lookup.resolve(account)
  await delay(30)
  assert.equal(gateway.status, 'stopped')
  assert.equal(gateway.lock, undefined)
  assert.deepEqual(client.notifications, [])
})

test('immediate shutdown during startup cannot publish a running gateway', async (t) => {
  const { client, gateway } = await setup(t)
  const starting = gateway.start()
  const stopping = gateway.stop()
  await Promise.all([starting, stopping])
  assert.equal(gateway.status, 'stopped')
  assert.equal(gateway.lock, undefined)
  assert.deepEqual(client.notifications, [])
})

for (const paused of [false, true]) {
  test(`ownership loss stops ${paused ? 'paused' : 'running'} polling`, async (t) => {
    const { config, client, gateway } = await setup(t, {
      config: { sessionPauseMs: 200 },
      gatewayOptions: { pauseHeartbeatMs: 10 },
    })
    await gateway.start()
    const path = join(config.stateDir, 'lock', 'bot1.lock')
    const { hostname } = await import('node:os')
    await writeFile(path, JSON.stringify({ token: 'replacement', pid: process.pid, host: hostname(), heartbeat: Date.now() }))
    if (paused) client.pausedOnce = 'pending'
    client.push({ msgs: [] })
    await waitFor(() => gateway.status === 'error')
    assert.equal(gateway.abort.signal.aborted, true)
    await gateway.stop()
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'replacement')
  })
}

test('a corrupt state file fails startup instead of dropping session mappings', async (t) => {
  const { config, gateway } = await setup(t)
  await mkdir(join(config.stateDir, 'state'), { recursive: true })
  await writeFile(join(config.stateDir, 'state', 'bot1.json'), '{broken', 'utf8')

  await assert.rejects(() => gateway.start(), /not valid JSON/)
  assert.equal(gateway.status, 'error')
})
