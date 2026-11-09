/**
 * Media failures with stable, routable codes.
 *
 * The gateway maps these codes onto human-facing replies. Messages deliberately
 * avoid CDN URLs, query parameters, and AES keys so an error can be logged or
 * echoed without leaking media credentials.
 *
 * @module dsh-weixin-gateway/media/errors
 */

/** Failure raised while downloading, decrypting, or validating media. */
export class MediaError extends Error {
  /**
   * @param {string} code - stable failure code, e.g. `media/too-large`.
   * @param {string} message - human-facing reason without secrets.
   * @param {object} [details] - additional classification fields.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    if (details.cause !== undefined) this.cause = details.cause
    if (details.status !== undefined) this.status = details.status
    if (details.bytes !== undefined) this.bytes = details.bytes
    if (details.maxBytes !== undefined) this.maxBytes = details.maxBytes
  }
}
