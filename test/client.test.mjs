import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ILinkClient,
  ILinkError,
  SessionPausedError,
  normalizeBaseUrl,
  normalizeServerOrigin,
} from '../src/ilink/client.mjs'
import { encodeClientVersion, VERSION } from '../src/ilink/constants.mjs'
import { withHttpServer } from './helpers/fake-client.mjs'

test('encodeClientVersion packs 0x00MMNNPP as a decimal string', () => {
  assert.equal(encodeClientVersion('0.1.0'), '256')
  assert.equal(encodeClientVersion('2.4.8'), String((2 << 16) | (4 << 8) | 8))
  assert.equal(encodeClientVersion('1.2.3-beta.1'), String((1 << 16) | (2 << 8) | 3))
})

test('normalizeBaseUrl accepts hosts and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
})

test('normalizeBaseUrl refuses an origin that would leak the bot token', () => {
  const insecure = (error) => error instanceof ILinkError && error.code === 'insecure-origin'
  const rejected = [
    'http://api.test',
    'ftp://api.test',
    'https://user:pass@api.test',
    'https://api.test?q=1',
    'https://api.test#fragment',
    'api.test not a url',
  ]
  for (const value of rejected) {
    assert.throws(() => normalizeBaseUrl(value), insecure, value)
  }
})

test('a loopback origin is an operator convenience, never a server one', () => {
  for (const value of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    assert.equal(normalizeBaseUrl(value), value)
    assert.throws(() => normalizeServerOrigin(value), { code: 'insecure-origin' }, value)
  }
  assert.equal(normalizeServerOrigin('other.example/'), 'https://other.example')
})

test('the client refuses an insecure origin and keeps the previous one on a bad switch', () => {
  assert.throws(() => new ILinkClient({ baseUrl: 'http://api.test', botToken: 'tok' }), {
    code: 'insecure-origin',
  })

  const client = new ILinkClient({ baseUrl: 'https://api.test', botToken: 'tok' })
  assert.throws(() => client.setBaseUrl('http://api.test'), { code: 'insecure-origin' })
  assert.equal(client.baseUrl, 'https://api.test')

  client.setBaseUrl('https://other.example/')
  assert.equal(client.baseUrl, 'https://other.example')
})

test('header sets differ per request class', () => {
  const client = new ILinkClient({ botToken: 'tok' })

  const app = client.headersFor('app', false)
  assert.equal(app['iLink-App-Id'], 'bot')
  assert.equal(app.AuthorizationType, undefined)
  assert.equal(app.Authorization, undefined)

  const qr = client.headersFor('qr', true)
  assert.equal(qr.AuthorizationType, 'ilink_bot_token')
  assert.equal(qr.Authorization, undefined)
  assert.equal(qr['Content-Type'], 'application/json')
  assert.match(Buffer.from(qr['X-WECHAT-UIN'], 'base64').toString('utf8'), /^\d+$/)

  const bot = client.headersFor('bot', true)
  assert.equal(bot.Authorization, 'Bearer tok')
  assert.equal(bot['Content-Type'], 'application/json')
})

test('QR start sends the unauthenticated header set and no base_info', async () => {
  await withHttpServer(
    () => ({ body: { qrcode: 'QR-1', qrcode_img_content: 'https://qr.example/1' } }),
    async ({ baseUrl, requests }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok', botAgent: 'dsh-weixin/test' })
      const result = await client.getBotQrcode({ localTokens: ['old-1'] })

      assert.equal(result.qrcode, 'QR-1')
      assert.equal(result.qrcodeImgContent, 'https://qr.example/1')

      const request = requests[0]
      assert.equal(request.method, 'POST')
      assert.match(request.url, /bot_type=3/)
      assert.equal(request.headers.authorizationtype, 'ilink_bot_token')
      assert.equal(request.headers.authorization, undefined)
      assert.ok(request.headers['x-wechat-uin'])
      assert.equal(request.headers['content-type'], 'application/json')
      assert.equal(request.body.base_info, undefined)
      assert.deepEqual(request.body.local_token_list, ['old-1'])
    },
  )
})

test('QR status polling is a GET with application headers only', async () => {
  await withHttpServer(
    () => ({ body: { status: 'wait' } }),
    async ({ baseUrl, requests }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      await client.getQrcodeStatus({ qrcode: 'QR 1', verifyCode: '1234' })

      const request = requests[0]
      assert.equal(request.method, 'GET')
      assert.match(request.url, /qrcode=QR\+1|qrcode=QR%201/)
      assert.match(request.url, /verify_code=1234/)
      assert.equal(request.headers.authorizationtype, undefined)
      assert.equal(request.headers.authorization, undefined)
      assert.ok(request.headers['ilink-app-id'])
    },
  )
})

for (const method of ['getBotQrcode', 'getQrcodeStatus']) {
  test(`${method} caps an optional QR budget at the shorter client timeout`, async (t) => {
    const client = new ILinkClient({ timeoutMs: 200 })
    const request = t.mock.method(client, 'request', async () => ({ qrcode: 'QR-1', status: 'wait' }))
    for (const timeoutMs of [undefined, 50, 500]) {
      await client[method]({ qrcode: 'QR-1', ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    }
    assert.deepEqual(request.mock.calls.map(({ arguments: [args] }) => args.timeoutMs), [200, 50, 200])
  })

  for (const phase of ['fetch', 'acknowledgement']) {
    for (const cancellation of ['login-budget', 'client-timeout', 'external-abort']) {
      test(`${method} cancels ${phase} on ${cancellation}`, { timeout: 1000 }, async (t) => {
        // AbortSignal.timeout is unref'ed; keep the network-free transport test alive.
        const keepAlive = setInterval(() => {}, 1000)
        t.after(() => clearInterval(keepAlive))
        const controller = new AbortController()
        let requestSignal
        let reads = 0
        const waitForAbort = (signal) => new Promise((_, reject) => {
          const onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (cancellation === 'external-abort') controller.abort()
          if (signal.aborted) onAbort()
        })
        const client = new ILinkClient({
          timeoutMs: cancellation === 'client-timeout' ? 20 : 500,
          fetchImpl: async (_url, { signal }) => {
            requestSignal = signal
            if (phase === 'fetch') return waitForAbort(signal)
            return {
              ok: true,
              text() {
                reads += 1
                return waitForAbort(signal)
              },
            }
          },
        })

        await assert.rejects(
          client[method]({
            qrcode: 'QR-1',
            timeoutMs: cancellation === 'login-budget' ? 20 : 500,
            signal: controller.signal,
          }),
          (error) => cancellation === 'external-abort'
            ? error.code === 'aborted'
            : error instanceof ILinkError && error.code === 'timeout' && error.retryable,
        )
        assert.equal(requestSignal.aborted, true)
        assert.equal(controller.signal.aborted, cancellation === 'external-abort')
        assert.equal(reads, phase === 'acknowledgement' ? 1 : 0)
      })
    }
  }
}

test('sendMessage carries auth, base_info, and the reply context token', async () => {
  await withHttpServer(
    () => ({ body: { ret: 0 } }),
    async ({ baseUrl, requests }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok', botAgent: 'dsh-weixin/test' })
      await client.sendMessage({ toUserId: 'u1', text: 'hi', contextToken: 'ctx-1' })

      const request = requests[0]
      assert.equal(request.headers.authorization, 'Bearer tok')
      assert.equal(request.body.base_info.channel_version, VERSION)
      assert.equal(request.body.base_info.bot_agent, 'dsh-weixin/test')
      assert.equal(request.body.msg.to_user_id, 'u1')
      assert.equal(request.body.msg.message_type, 2)
      assert.equal(request.body.msg.message_state, 2)
      assert.equal(request.body.msg.context_token, 'ctx-1')
      assert.deepEqual(request.body.msg.item_list, [{ type: 1, text_item: { text: 'hi' } }])
    },
  )
})

test('getUpdates passes the cursor and reads the new one', async () => {
  await withHttpServer(
    () => ({ body: { ret: 0, msgs: [], get_updates_buf: 'next', longpolling_timeout_ms: 1234 } }),
    async ({ baseUrl, requests }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      const batch = await client.getUpdates({ cursor: 'prev', timeoutMs: 1000 })

      assert.equal(requests[0].body.get_updates_buf, 'prev')
      assert.equal(batch.getUpdatesBuf, 'next')
      assert.equal(batch.longPollingTimeoutMs, 1234)
    },
  )
})

test('an out-of-range request timeout is clamped instead of throwing', async () => {
  await withHttpServer(
    () => ({ body: { ret: 0, msgs: [], get_updates_buf: 'next' } }),
    async ({ baseUrl, requests }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      // Node throws ERR_OUT_OF_RANGE above 2^32-1 and silently truncates the
      // timer to 1 ms above 2^31-1; either would break the poll loop.
      for (const timeoutMs of [4_294_967_296, 5e9, Infinity]) {
        const batch = await client.getUpdates({ cursor: '', timeoutMs })
        assert.equal(batch.timedOut, false)
      }
      assert.equal(requests.length, 3, 'every clamped request still reached the server')
    },
  )
})

test('a timeout in Node\'s truncation range still allows a slow response', async () => {
  await withHttpServer(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { body: { ret: 0, msgs: [], get_updates_buf: 'next' } }
    },
    async ({ baseUrl }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      // Node accepts 2^32-1 but truncates the timer to 1 ms, which would abort
      // this 100 ms response; clamping to 2^31-1 keeps it a real deadline.
      const batch = await client.getUpdates({ cursor: '', timeoutMs: 4_294_967_295 })
      assert.equal(batch.timedOut, false)
      assert.equal(batch.getUpdatesBuf, 'next')
    },
  )
})

test('getUpdates maps a long-poll timeout to an empty batch', async () => {
  await withHttpServer(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { body: {} }
    },
    async ({ baseUrl }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      const batch = await client.getUpdates({ cursor: '', timeoutMs: 20 })
      assert.deepEqual(batch.msgs, [])
      assert.equal(batch.timedOut, true)
    },
  )
})

test('-14 raises SessionPausedError', async () => {
  await withHttpServer(
    () => ({ body: { ret: -14, errmsg: 'paused' } }),
    async ({ baseUrl }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      await assert.rejects(
        () => client.getUpdates({ timeoutMs: 1000 }),
        (error) => error instanceof SessionPausedError && error.code === 'session-paused',
      )
    },
  )
})

test('a non-zero business code raises ILinkError', async () => {
  await withHttpServer(
    () => ({ body: { ret: 1, errmsg: 'bad request' } }),
    async ({ baseUrl }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      await assert.rejects(
        () => client.sendMessage({ toUserId: 'u1', text: 'hi' }),
        (error) => error instanceof ILinkError && error.code === 'business' && error.ret === 1,
      )
    },
  )
})

test('an HTTP failure is classified and exposes the status', async () => {
  await withHttpServer(
    () => ({ status: 503, body: { message: 'down' } }),
    async ({ baseUrl }) => {
      const client = new ILinkClient({ baseUrl, botToken: 'tok' })
      await assert.rejects(
        () => client.sendMessage({ toUserId: 'u1', text: 'hi' }),
        (error) => error.code === 'http' && error.status === 503 && error.retryable === true,
      )
    },
  )
})
