import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Gateway } from '../src/runtime.mjs'
import { AccountStore } from '../src/store/accounts.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { ChannelState } from '../src/store/state.mjs'
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
async function setup(t, { msgs = [], config = {}, hostOptions = {}, allowed = true, account = true } = {}) {
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

test('a corrupt state file fails startup instead of dropping session mappings', async (t) => {
  const { config, gateway } = await setup(t)
  await mkdir(join(config.stateDir, 'state'), { recursive: true })
  await writeFile(join(config.stateDir, 'state', 'bot1.json'), '{broken', 'utf8')

  await assert.rejects(() => gateway.start(), /not valid JSON/)
  assert.equal(gateway.status, 'error')
})
