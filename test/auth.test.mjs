import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { LoginError, runQrLogin } from '../src/ilink/auth.mjs'
import { ILinkClient } from '../src/ilink/client.mjs'

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

test('an already-aborted login does not create a QR code', async () => {
  const controller = new AbortController()
  controller.abort()
  const client = authClient([])
  let creations = 0
  client.getBotQrcode = async () => { creations += 1; return { qrcode: 'QR-1' } }
  const io = fakeIo()

  await assert.rejects(
    runQrLogin({ client, io, signal: controller.signal }),
    (error) => error instanceof LoginError && error.code === 'aborted',
  )
  assert.equal(creations, 0)
  assert.equal(client.calls.length, 0)
  assert.deepEqual(io.printed, [])
})

for (const timeoutMs of [0, -1]) {
  test(`an exhausted initial budget (${timeoutMs}ms) does not create a QR code`, async () => {
    const client = authClient([])
    let creations = 0
    client.getBotQrcode = async () => { creations += 1; return { qrcode: 'QR-1' } }
    await assert.rejects(
      runQrLogin({ client, io: fakeIo(), timeoutMs, now: () => 0 }),
      (error) => error instanceof LoginError && error.code === 'timeout',
    )
    assert.equal(creations, 0)
  })
}

for (const scenario of [
  { name: 'QR creation', request: 1, payload: { qrcode: 'QR-1' } },
  { name: 'status', request: 2, payload: { status: 'need_verifycode' } },
  { name: 'confirmation', request: 2, payload: { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' } },
  { name: 'QR creation failure', request: 1, fail: true },
  { name: 'transient status failure', request: 2, fail: true },
]) {
  test(`a late ${scenario.name} reports the overall login timeout`, async () => {
    let clock = 0
    let requests = 0
    let presentations = 0
    const client = new ILinkClient({
      fetchImpl: async () => {
        requests += 1
        if (requests !== scenario.request) return new Response(JSON.stringify({ qrcode: 'QR-1' }))
        return {
          ok: true,
          async text() {
            // Model the acknowledgement finishing exactly at the deadline.
            clock = 100
            if (scenario.fail) throw new Error('connection lost while reading acknowledgement')
            return JSON.stringify(scenario.payload)
          },
        }
      },
    })
    const io = fakeIo()
    io.prompt = () => assert.fail('late status must not prompt for verification')
    await assert.rejects(
      runQrLogin({
        client,
        io,
        timeoutMs: 100,
        now: () => clock,
        onQrcode: () => { presentations += 1 },
        sleepFn: () => assert.fail('an exhausted login must not sleep or retry'),
      }),
      (error) => error instanceof LoginError && error.code === 'timeout',
    )
    assert.equal(requests, scenario.request)
    assert.equal(presentations, scenario.request === 1 ? 0 : 1)
  })
}

for (const phase of ['creation', 'status']) {
  for (const transportPhase of ['fetch', 'acknowledgement']) {
    test(`the overall budget cancels QR ${phase} during ${transportPhase}`, { timeout: 1000 }, async (t) => {
      const keepAlive = setInterval(() => {}, 1000)
      t.after(() => clearInterval(keepAlive))
      const timeout = t.mock.method(AbortSignal, 'timeout')
      let clock = 0
      let requests = 0
      let cancelledSignal
      const stalledRequest = phase === 'creation' ? 1 : 2
      const waitForAbort = (signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          clock = 50
          cancelledSignal = signal
          reject(signal.reason)
        }, { once: true })
      })
      const client = new ILinkClient({
        timeoutMs: 500,
        fetchImpl: async (_url, { signal }) => {
          requests += 1
          if (requests !== stalledRequest) {
            return { ok: true, async text() { clock = 20; return JSON.stringify({ qrcode: 'QR-1' }) } }
          }
          if (transportPhase === 'fetch') return waitForAbort(signal)
          return { ok: true, text: () => waitForAbort(signal) }
        },
      })

      await assert.rejects(
        runQrLogin({
          client,
          io: fakeIo(),
          timeoutMs: 50,
          now: () => clock,
          sleepFn: () => assert.fail('an exhausted login must not retry'),
        }),
        (error) => error instanceof LoginError && error.code === 'timeout',
      )
      assert.equal(cancelledSignal.aborted, true)
      assert.equal(requests, stalledRequest)
      assert.deepEqual(timeout.mock.calls.map(({ arguments: [ms] }) => ms), phase === 'creation' ? [50] : [50, 30])
    })
  }
}

for (const phase of ['creation', 'confirmation']) {
  test(`external abort during a completed ${phase} acknowledgement cannot finish login`, async () => {
    const controller = new AbortController()
    let requests = 0
    const abortOnRequest = phase === 'creation' ? 1 : 2
    const client = new ILinkClient({
      fetchImpl: async () => {
        requests += 1
        return {
          ok: true,
          async text() {
            if (requests === abortOnRequest) controller.abort()
            return JSON.stringify(requests === 1
              ? { qrcode: 'QR-1' }
              : { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' })
          },
        }
      },
    })
    await assert.rejects(
      runQrLogin({ client, io: fakeIo(), signal: controller.signal, timeoutMs: 1000 }),
      (error) => error instanceof LoginError && error.code === 'aborted',
    )
    assert.equal(requests, abortOnRequest)
  })
}

for (const reason of ['timeout', 'aborted']) {
  test(`confirmation rechecks ${reason} after status processing`, async () => {
    let clock = 0
    const controller = new AbortController()
    const client = authClient([{ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' }])
    await assert.rejects(
      runQrLogin({
        client,
        io: fakeIo(),
        signal: controller.signal,
        timeoutMs: 100,
        now: () => clock,
        logger: {
          debug() {
            if (reason === 'timeout') clock = 100
            else controller.abort()
          },
        },
      }),
      (error) => error instanceof LoginError && error.code === reason,
    )
  })
}

test('every QR request receives the decreasing budget, including verification submission', async () => {
  let clock = 0
  let creationArgs
  const client = authClient([
    { status: 'wait' },
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' },
  ])
  client.getBotQrcode = async (args) => {
    creationArgs = args
    clock += 15
    return { qrcode: 'QR-1' }
  }
  const original = client.getQrcodeStatus.bind(client)
  client.getQrcodeStatus = async (args) => {
    clock += 10
    return original(args)
  }
  const io = fakeIo()
  io.prompt = async () => { clock += 5; return ' 9876 ' }
  const sleeps = []
  const controller = new AbortController()
  const credentials = await runQrLogin({
    client,
    io,
    localTokens: ['old-token'],
    signal: controller.signal,
    timeoutMs: 100,
    pollIntervalMs: 20,
    now: () => clock,
    sleepFn: async (ms) => { sleeps.push(ms); clock += ms },
  })

  assert.equal(credentials.botId, 'b')
  assert.deepEqual(creationArgs, { localTokens: ['old-token'], signal: controller.signal, timeoutMs: 100 })
  assert.deepEqual(client.calls.map((args) => args.timeoutMs), [85, 55, 40])
  assert.equal(client.calls.at(-1).verifyCode, '9876')
  assert.ok(client.calls.every((args) => args.signal === controller.signal))
  assert.deepEqual(sleeps, [20])
})

for (const code of ['timeout', 'network', 'http']) {
  test(`a transient ${code} status failure retries with a smaller remaining budget`, async () => {
    let clock = 0
    const client = authClient([{ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' }])
    const original = client.getQrcodeStatus.bind(client)
    const budgets = []
    client.getQrcodeStatus = async (args) => {
      budgets.push(args.timeoutMs)
      if (budgets.length === 1) {
        clock += 20
        throw Object.assign(new Error('transient failure'), { code, retryable: true })
      }
      return original(args)
    }
    const credentials = await runQrLogin({
      client,
      io: fakeIo(),
      timeoutMs: 100,
      pollIntervalMs: 30,
      now: () => clock,
      sleepFn: async (ms) => { clock += ms },
    })
    assert.equal(credentials.botId, 'b')
    assert.deepEqual(budgets, [100, 50])
  })
}

for (const fails of [false, true]) {
  test(`sleep after a ${fails ? 'failed' : 'completed'} status poll uses only the remaining budget`, async () => {
    let clock = 0
    let polls = 0
    const sleeps = []
    const client = authClient([])
    client.getQrcodeStatus = async () => {
      polls += 1
      clock = 90
      if (fails) throw Object.assign(new Error('transient failure'), { code: 'network' })
      return { status: 'wait' }
    }
    await assert.rejects(
      runQrLogin({
        client,
        io: fakeIo(),
        timeoutMs: 100,
        pollIntervalMs: 70,
        now: () => clock,
        sleepFn: async (ms) => { sleeps.push(ms); clock += ms },
      }),
      (error) => error instanceof LoginError && error.code === 'timeout',
    )
    assert.equal(polls, 1)
    assert.deepEqual(sleeps, [10])
  })
}

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
