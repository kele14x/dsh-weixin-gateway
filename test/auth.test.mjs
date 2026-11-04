import test from 'node:test'
import assert from 'node:assert/strict'
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
