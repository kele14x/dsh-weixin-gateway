import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Gateway } from '../src/runtime.mjs'
import { AccountStore } from '../src/store/accounts.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { issuePairingCode } from '../src/store/pairing.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { acquireLock, LockError } from '../src/store/lock.mjs'
import { createLogger } from '../src/util/log.mjs'
import { FakeClient } from './helpers/fake-client.mjs'
import { FakeHost } from './helpers/fake-host.mjs'
import { FakeMedia, JPEG_BYTES } from './helpers/fake-media.mjs'
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

/**
 * Build one inbound message carrying images and optional text.
 *
 * @param {object} [options] - message fields.
 * @returns {object} raw iLink message.
 */
function imageMessage({ id = 1, from = 'u1', text = '', images = 1, context = 'ctx-1' } = {}) {
  const items = []
  if (text.length > 0) items.push({ type: 1, text_item: { text } })
  for (let index = 0; index < images; index += 1) {
    items.push({
      type: 2,
      image_item: {
        media: { encrypt_query_param: `param-${index}` },
        aeskey: '00112233445566778899aabbccddeeff',
        mid_size: 128,
      },
    })
  }
  return {
    message_id: id,
    from_user_id: from,
    to_user_id: 'bot',
    message_type: 1,
    context_token: context,
    create_time_ms: Date.now(),
    item_list: items,
  }
}

/** Open a manually driven, correlated turn for permission-flow tests. */
async function openGatewayTurn(t, options = {}) {
  const fixture = await setup(t, {
    ...options,
    config: { turnTimeoutMs: 3000, ...options.config },
    hostOptions: { autoRespond: false },
    msgs: [textMessage()],
  })
  await fixture.gateway.start()
  await waitFor(() => fixture.host.callsOf('prompt').length === 1)
  fixture.prompt = fixture.host.callsOf('prompt')[0]
  fixture.host.emit(fixture.prompt.sessionId, { type: 'turn/start', data: { turn: 1 } })
  fixture.host.emit(fixture.prompt.sessionId, {
    type: 'user/message', data: { source: { kind: 'user', rpcId: fixture.prompt.requestId } },
  })
  return fixture
}

/** Ask through the live seam and read the exact command id delivered to WeChat. */
async function askPermission(fixture, request = {}) {
  const { host, client, prompt } = fixture
  const before = client.sent.length
  const answer = host.requestApproval({
    sessionId: prompt.sessionId, toolName: 'shell', reason: 'Run outside the sandbox', ...request,
  })
  await waitFor(() => client.sent.slice(before).some((message) => message.text.startsWith('Permission required:')))
  const text = client.sent.slice(before).find((message) => message.text.startsWith('Permission required:')).text
  const id = text.match(/\/allow ([1-9][0-9]*)/)[1]
  return { id, answer, text }
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

test('an image-only message is sent to the host as an image prompt', async (t) => {
  const media = new FakeMedia()
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage()],
    gatewayOptions: { media },
  })
  await gateway.start()
  await waitFor(() => host.callsOf('prompt').length === 1, { message: 'image prompt' })

  assert.equal(media.calls.length, 1)
  const prompt = host.callsOf('prompt')[0]
  assert.equal(prompt.content.length, 1)
  assert.equal(prompt.content[0].type, 'image')
  assert.equal(prompt.content[0].mediaType, 'image/jpeg')
  assert.equal(prompt.content[0].data, JPEG_BYTES.toString('base64'))
  assert.equal(prompt.text, '')
  assert.doesNotMatch(client.sent[0]?.text ?? '', /Only text messages/)
})

test('text and images keep their order in one prompt', async (t) => {
  const media = new FakeMedia()
  const { host, gateway } = await setup(t, {
    msgs: [imageMessage({ text: 'what is this?', images: 2 })],
    gatewayOptions: { media },
  })
  await gateway.start()
  await waitFor(() => host.callsOf('prompt').length === 1, { message: 'mixed prompt' })

  const prompt = host.callsOf('prompt')[0]
  assert.deepEqual(prompt.content.map((part) => part.type), ['text', 'image', 'image'])
  assert.equal(prompt.content[0].text, 'what is this?')
})

test('an image download failure is answered without prompting the agent', async (t) => {
  const failure = Object.assign(new Error('media download answered HTTP 500'), {
    code: 'media/http',
    status: 500,
  })
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage()],
    gatewayOptions: { media: new FakeMedia({ failWith: failure }) },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'failure reply' })

  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /Could not download the image/)
})

test('an unsupported image format is answered with an actionable notice', async (t) => {
  const failure = Object.assign(new Error('not an image'), { code: 'media/unsupported-type' })
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage()],
    gatewayOptions: { media: new FakeMedia({ failWith: failure }) },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'format reply' })

  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /PNG, JPEG, WebP, or GIF/)
})

test('a text-only model rejection is answered with a model hint', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage()],
    gatewayOptions: { media: new FakeMedia() },
  })
  host.prompt = async (options) => {
    host.calls.push({ type: 'prompt', sessionId: options.sessionId, requestId: options.requestId })
    throw Object.assign(new Error('Model "deepseek-v4-pro" does not support image input.'), {
      code: 'session/attachment-invalid',
      details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    })
  }
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'model hint' })

  assert.equal(host.callsOf('prompt').length, 1)
  assert.match(client.sent[0].text, /does not accept image input/)})

test('an unpaired sender cannot trigger an image download', async (t) => {
  const media = new FakeMedia()
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage({ from: 'u2' })],
    allowed: false,
    gatewayOptions: { media },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'pairing hint' })

  assert.equal(media.calls.length, 0)
  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /not paired/)
})

test('disabled media keeps text and refuses image-only messages', async (t) => {
  const media = new FakeMedia()
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage()],
    config: { mediaEnabled: false },
    gatewayOptions: { media },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'media disabled notice' })

  assert.equal(media.calls.length, 0)
  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /not enabled/)
})

test('a non-image attachment is answered with a support notice', async (t) => {
  const { client, host, gateway } = await setup(t, {
    msgs: [
      {
        message_id: 12,
        from_user_id: 'u1',
        message_type: 1,
        context_token: 'ctx',
        item_list: [{ type: 4, file_item: { file_name: 'report.pdf' } }],
      },
    ],
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'unsupported attachment notice' })

  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /Only text and image messages/)
})

test('more images than the configured limit are refused before download', async (t) => {
  const media = new FakeMedia()
  const { client, host, gateway } = await setup(t, {
    msgs: [imageMessage({ images: 10 })],
    gatewayOptions: { media },
  })
  await gateway.start()
  await waitFor(() => client.sent.length > 0, { message: 'image count notice' })

  assert.equal(media.calls.length, 0)
  assert.equal(host.callsOf('prompt').length, 0)
  assert.match(client.sent[0].text, /Too many images/)
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

for (const selection of ['missing', 'dangling']) {
  test(`a ${selection} active-account selection cannot fall back to another credential`, async (t) => {
    const { accounts, client, gateway } = await setup(t)
    if (selection === 'missing') await rm(accounts.activeFile)
    else await writeFile(accounts.activeFile, JSON.stringify({ version: 1, botId: 'absent-bot' }))
    await gateway.start()
    assert.equal(gateway.status, 'unconfigured')
    assert.equal((await accounts.load('bot1')).botId, 'bot1')
    assert.deepEqual(client.notifications, [])
  })
}

for (const selection of ['{broken-json', '{"version":1,"botId":42}']) {
  test(`an invalid active-account selection fails startup: ${selection}`, async (t) => {
    const { accounts, client, gateway } = await setup(t)
    await writeFile(accounts.activeFile, selection)
    await assert.rejects(() => gateway.start(), /not valid JSON|unexpected active-account document shape/)
    assert.equal(gateway.status, 'error')
    assert.deepEqual(client.notifications, [])
  })
}

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
  const account = await accounts.active()
  await gateway.start()
  assert.equal(gateway.status, 'locked')
  const lookup = Promise.withResolvers()
  t.after(() => lookup.resolve(account))
  accounts.active = () => lookup.promise
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

test('a code issued while the gateway runs pairs a sender without a restart', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  delete process.env.DSH_WEIXIN_BIND_CODE
  t.after(() => {
    if (previous !== undefined) process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { client, gateway, dir } = await setup(t, { allowed: false })
  await gateway.start()
  client.push({ msgs: [textMessage({ id: 1, from: 'u2', text: '/bind early' })] })
  await waitFor(() => client.sent.length === 1, { message: 'not-open reply' })
  assert.match(client.sent[0].text, /not open/)

  const { code } = await issuePairingCode(dir)
  client.push({ msgs: [textMessage({ id: 2, from: 'u2', text: `/bind ${code}` })] })
  await waitFor(() => client.sent.length === 2, { message: 'bind reply' })
  assert.match(client.sent[1].text, /^Paired\./)
})

for (const [command, outcome] of [['allow', 'allowed-once'], ['deny', 'rejected']]) {
  test(`/${command} answers the pending request without enqueueing a prompt`, async (t) => {
    const fixture = await openGatewayTurn(t)
    const { host, client, gateway, prompt } = fixture
    const { id, answer, text } = await askPermission(fixture)
    assert.match(text, /Tool: shell/)
    assert.match(text, /Reason: Run outside the sandbox/)
    assert.ok(text.includes(`/deny ${id}`))
    assert.equal(client.sent[0].toUserId, 'u1')
    assert.equal(client.sent[0].contextToken, 'ctx-1')
    assert.ok(gateway.statusText('u1').includes(`/allow ${id}`))

    client.push({ msgs: [textMessage({ id: 2, text: `/${command} ${id}` })] })
    assert.equal(await answer, outcome)
    await waitFor(() => client.sent.length === 2)
    assert.equal(host.callsOf('prompt').length, 1)
    assert.equal(gateway.approvals.size, 0)
    assert.match(client.sent[1].text, command === 'allow' ? /allow once/ : /denied/)

    host.emit(prompt.sessionId, {
      type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Finished.' }] } },
    })
    host.emit(prompt.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitFor(() => client.sent.some((message) => message.text === 'Finished.'))

    client.push({ msgs: [textMessage({ id: 3, text: `/allow ${id}` })] })
    await waitFor(() => client.sent.some((message) => /no longer pending/.test(message.text)))
    assert.equal(host.callsOf('prompt').length, 1, 'a stale approval command must not become a new prompt')
  })
}

test('ordinary yes/allow text cannot answer a request or bypass the turn queue', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { client, gateway, host } = fixture
  const { id, answer } = await askPermission(fixture)
  client.push({ msgs: [textMessage({ id: 2, text: 'yes, allow it' })] })
  await waitFor(() => gateway.queues.get('u1')?.length === 1)
  assert.equal(gateway.approvals.size, 1)
  assert.equal(host.callsOf('prompt').length, 1)
  client.push({ msgs: [textMessage({ id: 3, text: `/deny ${id}` })] })
  assert.equal(await answer, 'rejected')
})

test('another paired sender and an unpaired sender cannot answer or inspect the request', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { client, gateway, host } = fixture
  await gateway.allowed.allow('u2')
  const { id, answer } = await askPermission(fixture)
  assert.equal(gateway.statusText('u2').includes(`/allow ${id}`), false)
  client.push({ msgs: [
    textMessage({ id: 2, from: 'u2', text: `/allow ${id}` }),
    textMessage({ id: 3, from: 'u3', text: `/allow ${id}` }),
  ] })
  await waitFor(() => client.sent.length === 3)
  assert.match(client.sent[1].text, /no longer pending/)
  assert.match(client.sent[2].text, /not paired/)
  assert.equal(gateway.approvals.size, 1)
  assert.equal(host.callsOf('prompt').length, 1)
  client.push({ msgs: [textMessage({ id: 4, text: `/deny ${id}` })] })
  assert.equal(await answer, 'rejected')
})

test('conflicting replies consume a permission request exactly once', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { id, answer } = await askPermission(fixture)
  fixture.client.push({ msgs: [
    textMessage({ id: 2, text: `/deny ${id}` }),
    textMessage({ id: 3, text: `/allow ${id}` }),
  ] })
  assert.equal(await answer, 'rejected')
  await waitFor(() => fixture.client.sent.length === 3)
  assert.match(fixture.client.sent[2].text, /no longer pending/)
  assert.equal(fixture.host.callsOf('prompt').length, 1)
})

test('multiple permission requests have independent ids and decisions', async (t) => {
  const fixture = await openGatewayTurn(t)
  const first = await askPermission(fixture, { toolName: 'shell' })
  const second = await askPermission(fixture, { toolName: 'edit' })
  assert.equal(first.id, '1')
  assert.equal(second.id, '2')
  const persisted = JSON.parse(await readFile(fixture.gateway.state.file, 'utf8'))
  assert.equal(persisted.approvalCounters.u1, 2)
  fixture.client.push({ msgs: [
    textMessage({ id: 2, text: `/allow ${second.id}` }),
    textMessage({ id: 3, text: `/deny ${first.id}` }),
  ] })
  assert.equal(await second.answer, 'allowed-once')
  assert.equal(await first.answer, 'rejected')
  assert.equal(fixture.gateway.approvals.size, 0)
})

test('simultaneous approval requests in one chat receive distinct persisted numbers', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t)
  const first = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell' })
  const second = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'edit' })
  await waitFor(() => client.sent.length === 2)
  assert.ok(client.sent[0].text.includes('/allow 1'))
  assert.ok(client.sent[1].text.includes('/allow 2'))
  const persisted = JSON.parse(await readFile(gateway.state.file, 'utf8'))
  assert.equal(persisted.approvalCounters.u1, 2)
  client.push({ msgs: [
    textMessage({ id: 2, text: '/allow 1' }),
    textMessage({ id: 3, text: '/deny 2' }),
  ] })
  assert.equal(await first, 'allowed-once')
  assert.equal(await second, 'rejected')
  assert.equal(gateway.approvals.size, 0)
})

test('audit events are not interactive approval requests', async (t) => {
  const { host, client, prompt, gateway } = await openGatewayTurn(t)
  host.emit(prompt.sessionId, { type: 'approval/asked', data: { id: 'audit-id', toolName: 'shell' } })
  host.emit(prompt.sessionId, { type: 'approval/decided', data: { id: 'audit-id', outcome: 'unavailable' } })
  assert.equal(client.sent.length, 0)
  assert.equal(gateway.approvals.size, 0)
})

test('unrelated sessions and other turns delegate to the next Host answerer', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t)
  let delegated = 0
  host.onApproval(() => { delegated += 1; return 'rejected' })
  assert.equal(await host.requestApproval({ sessionId: 'desktop', toolName: 'shell' }), 'rejected')
  host.emit(prompt.sessionId, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(await host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell' }), 'rejected')
  assert.equal(delegated, 2)
  assert.equal(client.sent.length, 0)
  assert.equal(gateway.approvals.size, 0)
})

test('an unmatched prompt cannot claim an earlier desktop approval in the same session', async (t) => {
  const { host, gateway, client } = await setup(t, {
    msgs: [textMessage()], hostOptions: { autoRespond: false },
  })
  await gateway.start()
  await waitFor(() => host.callsOf('prompt').length === 1)
  const { sessionId } = host.callsOf('prompt')[0]
  let delegated = 0
  host.onApproval(() => { delegated += 1; return 'rejected' })
  assert.equal(await host.requestApproval({ sessionId, toolName: 'shell' }), 'rejected')
  assert.equal(delegated, 1)
  assert.equal(client.sent.length, 0)
})

for (const withdrawal of ['request abort', 'stop', 'new', 'turn end', 'timeout', 'shutdown']) {
  test(`permission requests are withdrawn on ${withdrawal}`, async (t) => {
    const fixture = await openGatewayTurn(t, {
      config: { turnTimeoutMs: withdrawal === 'timeout' ? 150 : 3000 },
    })
    const { host, gateway, client, prompt } = fixture
    const controller = new AbortController()
    const { id, answer } = await askPermission(fixture, { signal: controller.signal })
    if (withdrawal === 'request abort') controller.abort()
    if (withdrawal === 'stop' || withdrawal === 'new') {
      client.push({ msgs: [textMessage({ id: 2, text: `/${withdrawal}` })] })
    }
    if (withdrawal === 'turn end') {
      host.emit(prompt.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    }
    if (withdrawal === 'shutdown') await gateway.stop()
    assert.equal(await answer, 'cancelled')
    assert.equal(gateway.approvals.size, 0)
    assert.match(gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
    if (withdrawal === 'shutdown') assert.equal(host.approvalListeners.size, 0)
  })
}

test('a failed timeout cancellation still withdraws the pending permission', async (t) => {
  const fixture = await openGatewayTurn(t, { config: { turnTimeoutMs: 150 } })
  const { id, answer } = await askPermission(fixture)
  fixture.host.cancel = () => { throw new Error('cancel unavailable') }
  assert.equal(await answer, 'cancelled')
  await waitFor(() => fixture.client.sent.some((message) => /Cancellation failed/.test(message.text)))
  assert.equal(fixture.gateway.active.get('u1').keepActive, true)
  assert.match(fixture.gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
})

test('a new session cannot reactivate requests from the old active turn', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { id, answer } = await askPermission(fixture)
  await fixture.gateway.newSession('u1')
  assert.equal(await answer, 'cancelled')
  assert.match(fixture.gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
  assert.equal(await fixture.host.requestApproval({ sessionId: fixture.prompt.sessionId, toolName: 'shell' }), 'unavailable')
  assert.equal(fixture.gateway.approvals.size, 0)
})

test('a revoked sender cannot approve a pending request', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { id, answer } = await askPermission(fixture)
  fixture.gateway.allowed.users.delete('u1')
  assert.match(fixture.gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
  assert.equal(await answer, 'cancelled')
})

test('a permission cannot be granted from /status before delivery finishes or fails', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t)
  let rejectSend
  client.sendMessage = () => new Promise((_, reject) => { rejectSend = reject })
  const answer = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell' })
  await waitFor(() => gateway.approvals.size === 1)
  const id = gateway.statusText('u1').match(/\/allow ([1-9][0-9]*)/)[1]
  assert.match(gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /still being delivered/)
  assert.equal(gateway.approvals.size, 1)
  rejectSend(Object.assign(new Error('delivery rejected'), { code: 'http' }))
  assert.equal(await answer, 'unavailable')
  assert.match(gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
})

test('a failed /stop still withdraws permissions and prevents new approval requests for that turn', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { id, answer } = await askPermission(fixture)
  fixture.host.cancel = () => { throw new Error('cancel unavailable') }
  fixture.client.push({ msgs: [textMessage({ id: 2, text: '/stop' })] })
  assert.equal(await answer, 'cancelled')
  await waitFor(() => fixture.client.sent.some((message) => /Could not cancel/.test(message.text)))
  assert.match(fixture.gateway.respondApproval('u1', { id, outcome: 'allowed-once' }), /no longer pending/)
  assert.equal(await fixture.host.requestApproval({ sessionId: fixture.prompt.sessionId, toolName: 'shell' }), 'unavailable')
})

test('withdrawing a permission stops delivery of its remaining chunks', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t, {
    config: { maxMessageChars: 40, chunkDelayMs: 100 },
  })
  const controller = new AbortController()
  const answer = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell', signal: controller.signal })
  await waitFor(() => client.sent.length === 1)
  controller.abort()
  assert.equal(await answer, 'cancelled')
  await delay(120)
  assert.equal(client.sent.length, 1)
  assert.equal(gateway.approvals.size, 0)
})

test('permission reasons and extra request fields do not reach default logs', async (t) => {
  const logs = []
  const logger = createLogger({ level: 'debug', sink: { log: (line) => logs.push(line), error: (line) => logs.push(line) } })
  const fixture = await openGatewayTurn(t, { gatewayOptions: { logger } })
  const { id, answer } = await askPermission(fixture, { reason: 'private-permission-reason' })
  fixture.client.push({ msgs: [textMessage({ id: 2, text: `/deny ${id}` })] })
  assert.equal(await answer, 'rejected')
  assert.equal(logs.join('').includes('private-permission-reason'), false)
})

test('failed permission delivery fails closed without waiting for the turn timeout', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t)
  client.failNextSends = 2
  assert.equal(await host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell' }), 'unavailable')
  assert.equal(client.sent.length, 0)
  assert.equal(gateway.approvals.size, 0)
})

test('already aborted and malformed requests fail closed without presenting a prompt', async (t) => {
  const { host, client, gateway, prompt } = await openGatewayTurn(t)
  const controller = new AbortController()
  controller.abort()
  assert.equal(await host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell', signal: controller.signal }), 'cancelled')
  assert.equal(await host.requestApproval({ sessionId: prompt.sessionId, toolName: '' }), 'unavailable')
  assert.equal(client.sent.length, 0)
  assert.equal(gateway.approvals.size, 0)
})

test('the approval counter is durable before any prompt is sent', async (t) => {
  const fixture = await openGatewayTurn(t)
  const send = fixture.client.sendMessage.bind(fixture.client)
  fixture.client.sendMessage = async (message) => {
    const id = message.text.match(/\/allow ([1-9][0-9]*)/)[1]
    const persisted = JSON.parse(await readFile(fixture.gateway.state.file, 'utf8'))
    assert.ok(persisted.approvalCounters.u1 >= Number(id))
    return send(message)
  }
  const { id, answer } = await askPermission(fixture)
  assert.equal(id, '1')
  assert.equal(fixture.gateway.respondApproval('u1', { id, outcome: 'rejected' }), 'Permission denied.')
  assert.equal(await answer, 'rejected')
})

for (const change of ['new', 'restart']) {
  test(`approval numbers survive ${change} and delayed decisions cannot approve a new request`, async (t) => {
    const fixture = await openGatewayTurn(t)
    const first = await askPermission(fixture)
    assert.equal(first.id, '1')
    const { gateway, host, client } = fixture
    if (change === 'new') {
      await gateway.newSession('u1')
      host.emit(fixture.prompt.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      assert.equal(await gateway.waitForQuiet(), true)
    } else {
      await gateway.stop()
      await gateway.start()
    }
    assert.equal(await first.answer, 'cancelled')
    client.push({ msgs: [textMessage({ id: 2, text: 'another task' })] })
    await waitFor(() => host.callsOf('prompt').length === 2)
    fixture.prompt = host.callsOf('prompt')[1]
    host.emit(fixture.prompt.sessionId, { type: 'turn/start', data: { turn: 2 } })
    host.emit(fixture.prompt.sessionId, {
      type: 'user/message', data: { source: { kind: 'user', rpcId: fixture.prompt.requestId } },
    })
    const second = await askPermission(fixture)
    assert.equal(second.id, '2')
    client.push({ msgs: [textMessage({ id: 3, text: '/allow 1' })] })
    await waitFor(() => client.sent.some((message) => /no longer pending/.test(message.text)))
    assert.equal(gateway.approvals.size, 1)
    client.push({ msgs: [textMessage({ id: 4, text: '/deny 2' })] })
    assert.equal(await second.answer, 'rejected')
    assert.equal(host.callsOf('prompt').length, 2)
  })
}

test('different chats can have pending request 1 without overwriting each other', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { host, client, gateway } = fixture
  await gateway.allowed.allow('u2')
  const first = await askPermission(fixture)
  client.push({ msgs: [textMessage({ id: 2, from: 'u2', text: 'another chat task' })] })
  await waitFor(() => host.callsOf('prompt').length === 2)
  const prompt = host.callsOf('prompt')[1]
  host.emit(prompt.sessionId, { type: 'turn/start', data: { turn: 1 } })
  host.emit(prompt.sessionId, { type: 'user/message', data: { source: { rpcId: prompt.requestId } } })
  const answer = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'edit' })
  await waitFor(() => client.sent.some((message) => message.toUserId === 'u2' && /\/allow 1\b/.test(message.text)))
  assert.equal(first.id, '1')
  assert.equal(gateway.approvals.size, 2)
  client.push({ msgs: [textMessage({ id: 3, from: 'u2', text: '/deny 1' })] })
  assert.equal(await answer, 'rejected')
  assert.equal(gateway.approvals.size, 1)
  client.push({ msgs: [textMessage({ id: 4, text: '/allow 1' })] })
  assert.equal(await first.answer, 'allowed-once')
  assert.equal(gateway.approvals.size, 0)
})

test('failed counter persistence presents nothing and retries use a new number', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { host, client, gateway, prompt } = fixture
  const flush = gateway.state.flush.bind(gateway.state)
  gateway.state.flush = async () => { throw new Error('private persistence failure') }
  assert.equal(await host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell' }), 'unavailable')
  assert.equal(client.sent.length, 0)
  assert.equal(gateway.approvals.size, 0)
  gateway.state.flush = flush
  const { id, answer } = await askPermission(fixture)
  assert.equal(id, '2')
  assert.match(gateway.respondApproval('u1', { id: '1', outcome: 'allowed-once' }), /no longer pending/)
  gateway.respondApproval('u1', { id, outcome: 'rejected' })
  assert.equal(await answer, 'rejected')
})

for (const change of ['request abort', 'stop', 'new', 'shutdown']) {
  test(`cancellation during counter persistence (${change}) cannot present an obsolete request`, async (t) => {
    const fixture = await openGatewayTurn(t)
    const { gateway, host, client, prompt } = fixture
    const nextId = gateway.state.nextApprovalId.bind(gateway.state)
    let release
    const held = new Promise((resolve) => { release = resolve })
    let allocated = false
    gateway.state.nextApprovalId = async (userId) => {
      const id = await nextId(userId)
      allocated = true
      await held
      return id
    }
    const controller = new AbortController()
    const answer = host.requestApproval({ sessionId: prompt.sessionId, toolName: 'shell', signal: controller.signal })
    await waitFor(() => allocated)
    assert.equal(gateway.approvals.size, 0)
    assert.equal(client.sent.length, 0)
    if (change === 'request abort') controller.abort()
    if (change === 'stop') gateway.stopTurn('u1')
    if (change === 'new') await gateway.newSession('u1')
    if (change === 'shutdown') await gateway.stop()
    release()
    assert.equal(await answer, 'cancelled')
    assert.equal(client.sent.some((message) => message.text.startsWith('Permission required:')), false)
    const persisted = JSON.parse(await readFile(gateway.state.file, 'utf8'))
    assert.equal(persisted.approvalCounters.u1, 1)
  })
}

test('permission context is bounded, localized, and excludes extra tool arguments', async (t) => {
  const fixture = await openGatewayTurn(t)
  const { id, answer, text } = await askPermission(fixture, {
    toolName: 'x'.repeat(1000), reason: 'private raw reason',
    displayReason: { en: 'r'.repeat(2000) },
    arguments: { secret: 'must-not-forward' },
  })
  assert.ok(text.length < 1000)
  assert.ok(text.includes(`/allow ${id}`))
  assert.equal(text.includes('must-not-forward'), false)
  assert.equal(text.includes('private raw reason'), false)
  assert.equal(text.includes('r'.repeat(601)), false)
  fixture.gateway.stopTurn('u1')
  assert.equal(await answer, 'cancelled')
})
