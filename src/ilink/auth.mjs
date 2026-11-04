/**
 * QR login flow.
 *
 * The state machine is exactly the eight statuses Tencent's protocol documents.
 * Two of them carry a `redirect_host` and require switching the API origin
 * before polling again, which is why the client passed in here is mutated
 * rather than a fresh one being built.
 *
 * @module dsh-weixin-gateway/ilink/auth
 */

import { sleep } from '../util/time.mjs'
import { silentLogger } from '../util/log.mjs'

/** QR login statuses documented by the iLink protocol. */
export const QR_STATUS = Object.freeze({
  wait: 'wait',
  scanned: 'scaned',
  needVerifyCode: 'need_verifycode',
  verifyCodeBlocked: 'verify_code_blocked',
  confirmed: 'confirmed',
  expired: 'expired',
  scannedButRedirect: 'scaned_but_redirect',
  bindedRedirect: 'binded_redirect',
})

/** Raised when QR login cannot complete. */
export class LoginError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - human-facing reason.
   */
  constructor(code, message) {
    super(message)
    this.name = 'LoginError'
    this.code = code
  }
}

/**
 * Run the QR login handshake until it yields credentials.
 *
 * @param {object} options - login options.
 * @param {import('./client.mjs').ILinkClient} options.client - unauthenticated client.
 * @param {{print: (line: string) => void, prompt: (question: string) => Promise<string>}} options.io - terminal adapter.
 * @param {string[]} [options.localTokens] - recent tokens offered to the backend.
 * @param {number} [options.pollIntervalMs] - delay between status polls.
 * @param {number} [options.timeoutMs] - overall login budget.
 * @param {number} [options.maxVerifyAttempts] - verification-code attempts.
 * @param {AbortSignal} [options.signal] - caller lifetime.
 * @param {(qr: {qrcode?: string, qrcodeImgContent?: string}) => void} [options.onQrcode] - QR presentation hook.
 * @param {number} [options.now] - clock override for tests.
 * @param {Function} [options.sleepFn] - sleep override for tests.
 * @param {object} [options.logger] - logger.
 * @returns {Promise<{botToken: string, botId: string, baseUrl: string, ownerUserId?: string}>} credentials.
 * @throws {LoginError} when the flow terminates without credentials.
 */
export async function runQrLogin({
  client,
  io,
  localTokens = [],
  pollIntervalMs = 1500,
  timeoutMs = 180_000,
  maxVerifyAttempts = 3,
  signal,
  onQrcode,
  now = Date.now,
  sleepFn = sleep,
  logger = silentLogger,
}) {
  const start = now()
  const deadline = start + timeoutMs

  const { qrcode, qrcodeImgContent } = await client.getBotQrcode({ localTokens, signal })
  if (typeof qrcode !== 'string' || qrcode.length === 0) {
    throw new LoginError('protocol', 'the QR response did not contain a qrcode value')
  }

  io.print('Open WeChat on your phone and scan the QR code below.')
  io.print('The WeChat account must have the ClawBot plugin enabled: Me → Settings → Plugins → ClawBot.')
  if (typeof onQrcode === 'function') {
    onQrcode({ qrcode, qrcodeImgContent })
  } else if (typeof qrcodeImgContent === 'string' && qrcodeImgContent.length > 0) {
    io.print(`QR: ${qrcodeImgContent}`)
  }

  let verifyCode
  let verifyAttempts = 0
  let lastStatus

  while (now() < deadline) {
    if (signal?.aborted) throw new LoginError('aborted', 'login was cancelled')

    let status
    try {
      status = await client.getQrcodeStatus({ qrcode, verifyCode, signal })
    } catch (error) {
      if (signal?.aborted || error.code === 'aborted') throw error
      // Tencent's own client maps a failed status poll to `wait` and keeps
      // polling; aborting here would kill a login over one transient timeout.
      if (error.code === 'timeout' || error.code === 'network' || (error.code === 'http' && error.retryable)) {
        logger.warn('QR status poll failed; retrying', { reason: error.message })
        const remaining = deadline - now()
        if (remaining <= 0) break
        await sleepFn(Math.min(pollIntervalMs, remaining), signal)
        continue
      }
      throw error
    }
    const value = status?.status

    if (value !== lastStatus) {
      logger.debug('QR status changed', { status: value })
      lastStatus = value
    }

    // A redirect can arrive with more than one status; honour it whenever sent.
    if (typeof status?.redirect_host === 'string' && status.redirect_host.length > 0) {
      const previous = client.baseUrl
      client.setBaseUrl(status.redirect_host)
      if (client.baseUrl !== previous) {
        io.print(`Login redirected to ${client.baseUrl}.`)
      }
    }

    switch (value) {
      case QR_STATUS.wait:
        break
      case QR_STATUS.scanned:
        io.print('QR scanned. Confirm the login on your phone.')
        break
      case QR_STATUS.needVerifyCode: {
        verifyAttempts += 1
        if (verifyAttempts > maxVerifyAttempts) {
          throw new LoginError('verify-code-blocked', 'too many incorrect verification codes')
        }
        const answer = await io.prompt('Enter the verification code shown on your phone: ')
        if (typeof answer !== 'string' || answer.trim().length === 0) {
          throw new LoginError('verify-code-required', 'a verification code is required to finish login')
        }
        verifyCode = answer.trim()
        // Poll again immediately with the code.
        continue
      }
      case QR_STATUS.verifyCodeBlocked:
        throw new LoginError(
          'verify-code-blocked',
          'too many incorrect verification codes; run login again to get a fresh QR code',
        )
      case QR_STATUS.confirmed: {
        if (typeof status.bot_token !== 'string' || status.bot_token.length === 0) {
          throw new LoginError('protocol', 'confirmed login did not include a bot token')
        }
        if (typeof status.ilink_bot_id !== 'string' || status.ilink_bot_id.length === 0) {
          throw new LoginError('protocol', 'confirmed login did not include a bot id')
        }
        return {
          botToken: status.bot_token,
          botId: status.ilink_bot_id,
          baseUrl: typeof status.baseurl === 'string' && status.baseurl.length > 0
            ? status.baseurl
            : client.baseUrl,
          ...(typeof status.ilink_user_id === 'string' && status.ilink_user_id.length > 0
            ? { ownerUserId: status.ilink_user_id }
            : {}),
        }
      }
      case QR_STATUS.expired:
        throw new LoginError('expired', 'the QR code expired; run login again')
      case QR_STATUS.scannedButRedirect:
        // The origin switch above is the whole handling; keep polling.
        break
      case QR_STATUS.bindedRedirect:
        throw new LoginError(
          'already-bound',
          'this bot is already bound to another running instance; start the gateway with the existing credential instead of logging in again',
        )
      default:
        throw new LoginError('protocol', `unexpected QR status: ${String(value)}`)
    }

    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleepFn(Math.min(pollIntervalMs, remaining), signal)
  }

  throw new LoginError('timeout', 'QR login timed out; run login again')
}
