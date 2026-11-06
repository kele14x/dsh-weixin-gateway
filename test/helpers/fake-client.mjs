/**
 * Fake iLink client and HTTP server helpers for offline tests.
 *
 * @module test/helpers/fake-client
 */

/**
 * Minimal iLink client stand-in. `getUpdates` blocks like a real long poll and
 * wakes when a batch is pushed or the gateway aborts.
 */
export class FakeClient {
  /**
   * @param {object} [options] - fake options.
   * @param {object[]} [options.batches] - batches to deliver immediately.
   */
  constructor({ batches = [] } = {}) {
    this.baseUrl = 'https://fake.test'
    this.batches = [...batches]
    this.sent = []
    this.typing = []
    this.notifications = []
    this.configCalls = 0
    this.failNextSends = 0
    this.loseNextAcks = 0
    this.pausedOnce = false
    this.waiter = undefined
    this.aborted = false
  }

  /**
   * Queue a batch for the next poll.
   *
   * @param {{msgs: object[], getUpdatesBuf?: string}} batch - batch.
   * @returns {void}
   */
  push(batch) {
    if (this.waiter !== undefined) {
      const resolve = this.waiter
      this.waiter = undefined
      resolve({ msgs: batch.msgs ?? [], getUpdatesBuf: batch.getUpdatesBuf, timedOut: false })
      return
    }
    this.batches.push(batch)
  }

  /**
   * Long poll.
   *
   * @param {{cursor: string, signal: AbortSignal}} options - poll options.
   * @returns {Promise<object>} one batch.
   */
  async getUpdates({ signal } = {}) {
    if (this.pausedOnce === 'pending') {
      this.pausedOnce = 'done'
      const error = new Error('iLink paused the account session (-14)')
      error.code = 'session-paused'
      throw error
    }
    if (this.batches.length > 0) {
      const batch = this.batches.shift()
      return { msgs: batch.msgs ?? [], getUpdatesBuf: batch.getUpdatesBuf, timedOut: false }
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined
        const error = new Error('aborted')
        error.code = 'aborted'
        reject(error)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      this.waiter = (batch) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(batch)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Record one outbound text message. `loseNextAcks` records the message and
   * then fails, as if the server accepted it but the response was lost.
   *
   * @param {{toUserId: string, text: string, contextToken?: string, clientId?: string}} message - message.
   * @returns {Promise<{clientId: string}>} receipt.
   */
  async sendMessage(message) {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1
      const error = new Error('network error')
      error.code = 'network'
      error.retryable = true
      throw error
    }
    this.sent.push(message)
    if (this.loseNextAcks > 0) {
      this.loseNextAcks -= 1
      const error = new Error('network error')
      error.code = 'network'
      error.retryable = true
      throw error
    }
    return { clientId: message.clientId ?? 'fake-client-id' }
  }

  /**
   * Return a typing ticket.
   *
   * @returns {Promise<{typingTicket: string}>} config.
   */
  async getConfig() {
    this.configCalls += 1
    return { typingTicket: 'ticket-1' }
  }

  /**
   * Record typing changes.
   *
   * @param {object} entry - typing call.
   * @returns {Promise<void>} resolves.
   */
  async sendTyping(entry) {
    this.typing.push(entry)
  }

  /** @returns {Promise<void>} resolves. */
  async notifyStart() {
    this.notifications.push('start')
  }

  /** @returns {Promise<void>} resolves. */
  async notifyStop() {
    this.notifications.push('stop')
  }
}

/**
 * Start a throwaway HTTP server that records requests.
 *
 * @param {(request: {method: string, url: string, headers: object, body: any}, index: number) => {status?: number, body?: any}} responder - reply builder.
 * @param {(context: {baseUrl: string, requests: object[]}) => Promise<any>} run - test body.
 * @returns {Promise<any>} the test body's value.
 */
export async function withHttpServer(responder, run) {
  const { createServer } = await import('node:http')
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const record = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: text.length > 0 ? JSON.parse(text) : undefined,
    }
    requests.push(record)
    const reply = await responder(record, requests.length)
    response.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' })
    response.end(reply?.body === undefined ? '' : JSON.stringify(reply.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}`, requests })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
