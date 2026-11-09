/**
 * iLink Bot API client.
 *
 * The client owns the wire contract only: URL building, the three header sets
 * the protocol actually uses (QR start, QR polling, authenticated bot calls),
 * `base_info`, timeout/abort handling, and server error mapping. Product logic
 * lives in `runtime.mjs`.
 *
 * Header sets, per Tencent's protocol notes:
 * - QR polling carries application headers only.
 * - QR start carries `AuthorizationType` and `X-WECHAT-UIN`, no `Authorization`,
 *   no `base_info`.
 * - Authenticated bot calls carry everything, including `base_info`.
 *
 * @module dsh-weixin-gateway/ilink/client
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  APP_ID,
  AUTH_TYPE,
  CLIENT_VERSION_HEADER,
  DEFAULT_BASE_URL,
  DEFAULT_POLL_TIMEOUT_MS,
  ITEM_TYPE_TEXT,
  MESSAGE_STATE_COMPLETE,
  OUTBOUND_MESSAGE_TYPE,
  PATHS,
  VERSION,
  botAgentFor,
} from './constants.mjs'
import { abortError } from '../util/time.mjs'
import { silentLogger } from '../util/log.mjs'
import { parseJsonPreservingIds } from './json.mjs'

/** Error raised for transport, HTTP, protocol, or business failures. */
export class ILinkError extends Error {
  /**
   * @param {string} message - human-facing reason.
   * @param {object} [details] - classification details.
   */
  constructor(message, { code = 'ilink', status, ret, errcode, errmsg, retryable = false, cause } = {}) {
    super(message)
    this.name = 'ILinkError'
    this.code = code
    if (status !== undefined) this.status = status
    if (ret !== undefined) this.ret = ret
    if (errcode !== undefined) this.errcode = errcode
    if (errmsg !== undefined) this.errmsg = errmsg
    this.retryable = retryable
    if (cause !== undefined) this.cause = cause
  }
}

/** Error raised when iLink answers `-14`: the account session is paused. */
export class SessionPausedError extends ILinkError {
  /**
   * @param {string} message - human-facing reason.
   * @param {object} [details] - classification details.
   */
  constructor(message, details = {}) {
    super(message, { ...details, code: 'session-paused', retryable: false })
    this.name = 'SessionPausedError'
  }
}

/**
 * Normalize a base URL or bare host into an origin.
 *
 * @param {string} value - origin or host, optionally with a trailing slash.
 * @returns {string} origin without a trailing slash.
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return DEFAULT_BASE_URL
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * base64 of the decimal string of a random uint32, as the protocol specifies.
 *
 * @returns {string} `X-WECHAT-UIN` value.
 */
function randomWechatUin() {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/** Thin iLink HTTP client for one bot account. */
export class ILinkClient {
  /**
   * @param {object} options - client options.
   * @param {string} [options.baseUrl] - API origin.
   * @param {string} [options.botToken] - bearer token; required by authenticated calls.
   * @param {string} [options.clientVersion] - encoded client version header value.
   * @param {string} [options.packageVersion] - `channel_version` value.
   * @param {string} [options.botAgent] - `bot_agent` observability token.
   * @param {string} [options.skRouteTag] - optional routing tag header.
   * @param {Function} [options.fetchImpl] - fetch implementation, for tests.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {number} [options.pollTimeoutMs] - long-poll budget.
   * @param {object} [options.logger] - logger.
   */
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    botToken,
    clientVersion = CLIENT_VERSION_HEADER,
    packageVersion = VERSION,
    botAgent = botAgentFor(VERSION),
    skRouteTag,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    logger = silentLogger,
  }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    this._baseUrl = normalizeBaseUrl(baseUrl)
    this.botToken = botToken
    this.clientVersion = clientVersion
    this.packageVersion = packageVersion
    this.botAgent = botAgent
    this.skRouteTag = skRouteTag
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.pollTimeoutMs = pollTimeoutMs
    this.logger = logger
    this.uin = randomWechatUin()
  }

  /** Current API origin. */
  get baseUrl() {
    return this._baseUrl
  }

  /**
   * Switch origin after a QR redirect.
   *
   * @param {string} value - new origin or host.
   * @returns {void}
   */
  setBaseUrl(value) {
    this._baseUrl = normalizeBaseUrl(value)
  }

  /**
   * Build the header set for one request class.
   *
   * @param {'app'|'qr'|'bot'} kind - request class.
   * @param {boolean} json - whether a JSON body is sent.
   * @returns {Record<string,string>} headers.
   */
  headersFor(kind, json) {
    const headers = {
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': this.clientVersion,
    }
    if (this.skRouteTag) headers.SKRouteTag = this.skRouteTag
    if (json) headers['Content-Type'] = 'application/json'
    if (kind === 'qr' || kind === 'bot') {
      headers.AuthorizationType = AUTH_TYPE
      headers['X-WECHAT-UIN'] = this.uin
    }
    if (kind === 'bot') {
      if (typeof this.botToken !== 'string' || this.botToken.length === 0) {
        throw new ILinkError('bot token is required for authenticated calls', { code: 'auth' })
      }
      headers.Authorization = `Bearer ${this.botToken}`
    }
    return headers
  }

  /**
   * Build one absolute URL with a query string.
   *
   * @param {string} path - endpoint path.
   * @param {Record<string,string>} [query] - query parameters.
   * @returns {string} absolute URL.
   */
  url(path, query) {
    const url = new URL(`${this._baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Execute one request and classify failures.
   *
   * @param {object} request - request description.
   * @param {'app'|'qr'|'bot'} request.kind - request class.
   * @param {'GET'|'POST'} [request.method] - HTTP method.
   * @param {string} request.path - endpoint path.
   * @param {Record<string,string>} [request.query] - query parameters.
   * @param {object} [request.body] - JSON body.
   * @param {number} [request.timeoutMs] - per-request timeout.
   * @param {AbortSignal} [request.signal] - caller lifetime.
   * @returns {Promise<any>} parsed response body.
   */
  async request({ kind, method = 'POST', path, query, body, timeoutMs = this.timeoutMs, signal }) {
    const hasBody = body !== undefined
    const payload = hasBody
      ? { ...body, ...(kind === 'bot' ? { base_info: this.baseInfo() } : {}) }
      : undefined

    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    let response
    let text
    try {
      response = await this.fetchImpl(this.url(path, query), {
        method,
        headers: this.headersFor(kind, hasBody),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: combined,
      })
      text = await response.text()
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (timeoutSignal.aborted) {
        throw new ILinkError('request timed out', { code: 'timeout', retryable: true, cause: error })
      }
      throw new ILinkError(`network error: ${error.message}`, {
        code: 'network',
        retryable: true,
        cause: error,
      })
    }

    if (!response.ok) {
      throw new ILinkError(`HTTP ${response.status} from ${path}`, {
        code: 'http',
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      })
    }

    let data = {}
    if (text.length > 0) {
      try {
        // iLink returns uint64 ids as JSON numbers; parse them losslessly so
        // dedupe never merges two distinct messages that lost precision.
        data = parseJsonPreservingIds(text)
      } catch (error) {
        throw new ILinkError('malformed JSON response', { code: 'protocol', cause: error })
      }
    }

    if (kind === 'bot') this.assertBusinessSuccess(data)
    return data
  }

  /**
   * Map iLink business codes onto errors; `-14` pauses the account session.
   *
   * @param {any} data - parsed response.
   * @returns {void}
   */
  assertBusinessSuccess(data) {
    if (data === null || typeof data !== 'object') return
    const ret = data.ret
    const errcode = data.errcode
    const failed = (ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)
    if (!failed) return

    if (ret === -14 || errcode === -14) {
      throw new SessionPausedError('iLink paused the account session (-14)', {
        ret,
        errcode,
        errmsg: data.errmsg,
      })
    }
    throw new ILinkError(data.errmsg ?? `iLink error (ret=${ret}, errcode=${errcode})`, {
      code: 'business',
      ret,
      errcode,
      errmsg: data.errmsg,
    })
  }

  /**
   * The `base_info` block carried by authenticated bot POSTs.
   *
   * @returns {{channel_version: string, bot_agent: string}} base info.
   */
  baseInfo() {
    return { channel_version: this.packageVersion, bot_agent: this.botAgent }
  }

  /**
   * Start a QR login.
   *
   * @param {object} [options] - request options.
   * @param {string[]} [options.localTokens] - recent tokens, at most ten.
   * @param {number} [options.timeoutMs] - remaining login budget, capped by the client timeout.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<{qrcode: string, qrcodeImgContent?: string}>} QR payload.
   */
  async getBotQrcode({ localTokens = [], timeoutMs = this.timeoutMs, signal } = {}) {
    const data = await this.request({
      kind: 'qr',
      path: PATHS.botQrcode,
      query: { bot_type: '3' },
      body: { local_token_list: localTokens.slice(0, 10) },
      timeoutMs: Math.min(this.timeoutMs, timeoutMs),
      signal,
    })
    return {
      qrcode: data.qrcode,
      qrcodeImgContent: data.qrcode_img_content,
    }
  }

  /**
   * Poll one QR login status.
   *
   * @param {object} options - poll options.
   * @param {string} options.qrcode - QR value from `getBotQrcode`.
   * @param {string} [options.verifyCode] - code shown on the phone.
   * @param {number} [options.timeoutMs] - remaining login budget, capped by the client timeout.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<object>} raw status document.
   */
  async getQrcodeStatus({ qrcode, verifyCode, timeoutMs = this.timeoutMs, signal }) {
    return this.request({
      kind: 'app',
      method: 'GET',
      path: PATHS.qrcodeStatus,
      query: {
        qrcode,
        ...(verifyCode === undefined || verifyCode === '' ? {} : { verify_code: verifyCode }),
      },
      signal,
      timeoutMs: Math.min(this.timeoutMs, timeoutMs),
    })
  }

  /**
   * Long-poll inbound messages.
   *
   * A timeout is a normal empty poll, not an error; a caller abort is rethrown
   * so shutdown can end the loop.
   *
   * @param {object} [options] - poll options.
   * @param {string} [options.cursor] - previous `get_updates_buf`.
   * @param {number} [options.timeoutMs] - long-poll budget.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<{msgs: object[], getUpdatesBuf?: string, longPollingTimeoutMs?: number, timedOut: boolean}>} batch.
   */
  async getUpdates({ cursor = '', timeoutMs = this.pollTimeoutMs, signal } = {}) {
    let data
    try {
      data = await this.request({
        kind: 'bot',
        path: PATHS.updates,
        body: { get_updates_buf: cursor },
        timeoutMs,
        signal,
      })
    } catch (error) {
      if (error.code === 'timeout') {
        return { msgs: [], timedOut: true }
      }
      throw error
    }
    return {
      msgs: Array.isArray(data.msgs) ? data.msgs : [],
      getUpdatesBuf: typeof data.get_updates_buf === 'string' ? data.get_updates_buf : undefined,
      longPollingTimeoutMs:
        typeof data.longpolling_timeout_ms === 'number' ? data.longpolling_timeout_ms : undefined,
      timedOut: false,
    }
  }

  /**
   * Send one text message.
   *
   * @param {object} options - message options.
   * @param {string} options.toUserId - recipient.
   * @param {string} options.text - message text.
   * @param {string} [options.contextToken] - reply context from the inbound message.
   * @param {string} [options.clientId] - idempotency hint; generated when omitted.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<{clientId: string}>} the client id used.
   */
  async sendMessage({ toUserId, text, contextToken, clientId = randomUUID(), signal }) {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: OUTBOUND_MESSAGE_TYPE,
      message_state: MESSAGE_STATE_COMPLETE,
      ...(contextToken === undefined || contextToken === '' ? {} : { context_token: contextToken }),
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
    }
    await this.request({ kind: 'bot', path: PATHS.sendMessage, body: { msg }, signal })
    return { clientId }
  }

  /**
   * Fetch the account config, including the typing ticket.
   *
   * @param {object} options - request options.
   * @param {string} options.userId - target user id.
   * @param {string} [options.contextToken] - conversation context.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<{typingTicket?: string}>} config values.
   */
  async getConfig({ userId, contextToken, signal }) {
    const data = await this.request({
      kind: 'bot',
      path: PATHS.getConfig,
      body: {
        ilink_user_id: userId,
        ...(contextToken === undefined || contextToken === '' ? {} : { context_token: contextToken }),
      },
      signal,
    })
    return { typingTicket: data.typing_ticket }
  }

  /**
   * Set or clear the typing indicator. Failures are the caller's to ignore.
   *
   * @param {object} options - typing options.
   * @param {string} options.userId - target user id.
   * @param {string} [options.typingTicket] - ticket from `getConfig`.
   * @param {number} options.status - 1 to start, 2 to stop.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @returns {Promise<void>} resolves once accepted.
   */
  async sendTyping({ userId, typingTicket, status, signal }) {
    await this.request({
      kind: 'bot',
      path: PATHS.sendTyping,
      body: { ilink_user_id: userId, typing_ticket: typingTicket ?? '', status },
      signal,
    })
  }

  /**
   * Tell the backend this client started.
   *
   * @returns {Promise<void>} resolves once accepted.
   */
  async notifyStart() {
    await this.request({ kind: 'bot', path: PATHS.notifyStart, body: {} })
  }

  /**
   * Tell the backend this client stopped.
   *
   * @returns {Promise<void>} resolves once accepted.
   */
  async notifyStop() {
    await this.request({ kind: 'bot', path: PATHS.notifyStop, body: {} })
  }
}
