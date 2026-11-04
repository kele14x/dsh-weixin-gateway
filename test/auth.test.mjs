import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { LoginError, runQrLogin } from '../src/ilink/auth.mjs'

/**
 * Build a scripted client for the login state machine.
 *
 * @param {object[]} statuses - responses in order.
 * @returns {object} fake client.
 */
function authClient(statuses) {
  return {
    baseUrl: 'https://start.test',
    statuses: [...statuses],
    calls: [],
    async getBotQrcode() {
      return { qrcode: 'QR-1', qrcodeImgContent: 'https://qr.example/1' }
    },
    async getQrcodeStatus(args) {
      this.calls.push(args)
      const next = this.statuses.shift()
      if (next === undefined) throw new Error('no scripted status left')
      return next
    },
    setBaseUrl(value) {
      this.baseUrl = value
    },
  }
}

/**
 * Terminal adapter that records output and answers verification prompts.
 *
 * @param {string} [answer] - verification code.
 * @returns {object} io stub.
 */
function fakeIo(answer = '1234') {
  return {
    printed: [],
    print(line) {
      this.printed.push(line)
    },
    async prompt() {
      return answer
    },
  }
}

test('completes the documented wait → scaned → verify → confirmed path', async () => {
  const client = authClient([
    { status: 'wait' },
    { status: 'scaned' },
    { status: 'need_verifycode' },
    {
      status: 'confirmed',
      bot_token: 'bot-token',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://api.test',
      ilink_user_id: 'owner-1',
    },
  ])
  const io = fakeIo('9876')
  const qr = []
  const credentials = await runQrLogin({
    client,
    io,
    pollIntervalMs: 1,
    timeoutMs: 2000,
    onQrcode: (payload) => qr.push(payload),
  })

  assert.deepEqual(credentials, {
    botToken: 'bot-token',
    botId: 'bot-1',
    baseUrl: 'https://api.test',
    ownerUserId: 'owner-1',
  })
  assert.equal(qr.length, 1)
  assert.equal(qr[0].qrcode, 'QR-1')
  assert.equal(client.calls.at(-1).verifyCode, '9876')
  assert.ok(io.printed.some((line) => /ClawBot/.test(line)))
})

test('a scanned redirect switches the API origin before continuing', async () => {
  const client = authClient([
    { status: 'scaned_but_redirect', redirect_host: 'other.example' },
    { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', baseurl: 'https://other.example' },
  ])

  await runQrLogin({
    client,
    io: fakeIo(),
    pollIntervalMs: 1,
    timeoutMs: 1000,
  })

  assert.equal(client.calls.length, 2)
})

test('an expired QR code fails with an actionable code', async () => {
  const client = authClient([{ status: 'expired' }])
  await assert.rejects(
    () => runQrLogin({ client, io: fakeIo(), pollIntervalMs: 1, timeoutMs: 1000 }),
    (error) => error instanceof LoginError && error.code === 'expired',
  )
})

test('an already-bound bot is reported instead of overwritten', async () => {
  const client = authClient([{ status: 'binded_redirect' }])
  await assert.rejects(
    () => runQrLogin({ client, io: fakeIo(), pollIntervalMs: 1, timeoutMs: 1000 }),
    (error) => error instanceof LoginError && error.code === 'already-bound',
  )
})

test('a blocked verification code fails instead of looping', async () => {
  const client = authClient([{ status: 'verify_code_blocked' }])
  await assert.rejects(
    () => runQrLogin({ client, io: fakeIo(), pollIntervalMs: 1, timeoutMs: 1000 }),
    (error) => error instanceof LoginError && error.code === 'verify-code-blocked',
  )
})

test('a login that never confirms times out', async () => {
  const client = authClient(Array.from({ length: 100 }, () => ({ status: 'wait' })))
  await assert.rejects(
    () => runQrLogin({ client, io: fakeIo(), pollIntervalMs: 1, timeoutMs: 30 }),
    (error) => error instanceof LoginError && error.code === 'timeout',
  )
})

test('a confirmed response without a token is a protocol error', async () => {
  const client = authClient([{ status: 'confirmed', ilink_bot_id: 'b' }])
  await assert.rejects(
    () => runQrLogin({ client, io: fakeIo(), pollIntervalMs: 1, timeoutMs: 1000 }),
    (error) => error instanceof LoginError && error.code === 'protocol',
  )
})

test('a transient status-poll failure is treated as wait, not a failed login', async () => {
  const client = authClient([
    { status: 'wait' },
    {
      status: 'confirmed',
      bot_token: 'tok',
      ilink_bot_id: 'bot',
      baseurl: 'https://api.test',
    },
  ])
  const original = client.getQrcodeStatus.bind(client)
  let first = true
  client.getQrcodeStatus = async (args) => {
    if (first) {
      first = false
      const error = new Error('request timed out')
      error.code = 'timeout'
      throw error
    }
    return original(args)
  }

  const credentials = await runQrLogin({
    client,
    io: fakeIo(),
    pollIntervalMs: 1,
    timeoutMs: 1000,
  })
  assert.equal(credentials.botId, 'bot')
})

test('unresolved verification input times out using only the remaining login budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const client = authClient([{ status: 'wait' }, { status: 'need_verifycode' }])
  let clock = 0
  let inputSignal
  let prompted
  const started = new Promise((resolve) => { prompted = resolve })
  const io = fakeIo()
  io.prompt = (question, { signal }) => {
    inputSignal = signal
    prompted()
    return new Promise(() => {})
  }

  const login = runQrLogin({
    client,
    io,
    signal: controller.signal,
    timeoutMs: 100,
    pollIntervalMs: 70,
    now: () => clock,
    sleepFn: async (ms) => { clock += ms },
  })
  const failed = assert.rejects(login, (error) => error instanceof LoginError && error.code === 'timeout')
  await started
  t.mock.timers.tick(29)
  assert.equal(inputSignal.aborted, false)
  t.mock.timers.tick(1)
  await failed
  assert.equal(inputSignal.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(client.calls.length, 2)
})

test('external abort cancels login even when verification input never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  const client = authClient([{ status: 'need_verifycode' }])
  let inputSignal
  let prompted
  const started = new Promise((resolve) => { prompted = resolve })
  const io = fakeIo()
  io.prompt = (question, { signal }) => {
    inputSignal = signal
    prompted()
    return new Promise(() => {})
  }

  const login = runQrLogin({ client, io, signal: controller.signal, timeoutMs: 100 })
  const failed = assert.rejects(login, (error) => error instanceof LoginError && error.code === 'aborted')
  await started
  controller.abort()
  await failed
  assert.equal(inputSignal.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  t.mock.timers.tick(1000)
  assert.equal(client.calls.length, 1)
})

test('successful verification clears its deadline and external abort listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clearTimer = t.mock.method(globalThis, 'clearTimeout')
  const controller = new AbortController()
  const client = authClient([
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
  ])
  const credentials = await runQrLogin({
    client,
    io: fakeIo(),
    signal: controller.signal,
    now: () => 0,
    timeoutMs: 100,
  })
  assert.equal(credentials.botId, 'b')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(clearTimer.mock.callCount(), 1)
  t.mock.timers.tick(1000)
})

test('a failed verification prompt preserves its error and cleans up cancellation resources', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clearTimer = t.mock.method(globalThis, 'clearTimeout')
  const controller = new AbortController()
  const client = authClient([{ status: 'need_verifycode' }])
  const failure = new Error('input failed')
  const io = fakeIo()
  io.prompt = () => { throw failure }
  await assert.rejects(
    runQrLogin({ client, io, signal: controller.signal, now: () => 0, timeoutMs: 100 }),
    (error) => error === failure,
  )
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(clearTimer.mock.callCount(), 1)
  t.mock.timers.tick(1000)
})
