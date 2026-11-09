/**
 * Inbound WeChat CDN media download.
 *
 * Phase 1 supports images: resolve the CDN URL, download bounded bytes, decrypt
 * AES-128-ECB with PKCS#7 padding when a key is present, and classify the image
 * from its magic bytes. Downloads are deliberately separate from
 * `ILinkClient.request`: the CDN must never receive the bot `Authorization`
 * header, and its responses are bytes, not JSON.
 *
 * @module dsh-weixin-gateway/media/download
 */

import { DEFAULT_CDN_BASE } from '../ilink/constants.mjs'
import { MediaError } from './errors.mjs'
import { decryptAesEcb, imageAesKey } from './crypto.mjs'

/** Default cap for one inbound image, applied to downloaded ciphertext bytes. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Default total deadline for one inbound media download. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 60_000

const CDN_HOST_SUFFIX = '.cdn.weixin.qq.com'

/**
 * Build the download URL for one media reference.
 *
 * The server-supplied `full_url` wins; otherwise the documented CDN path is
 * used. The query value is encoded with `encodeURIComponent` rather than
 * `URLSearchParams` so `+`, `/`, and `=` survive unchanged.
 *
 * @param {object} media - `CDNMedia` object.
 * @param {string} cdnBaseUrl - configured CDN origin and path.
 * @returns {string} absolute download URL.
 * @throws {MediaError} when the reference has no usable location.
 */
export function cdnDownloadUrl(media, cdnBaseUrl) {
  if (typeof media?.full_url === 'string' && media.full_url.trim().length > 0) {
    return media.full_url.trim()
  }
  if (typeof media?.encrypt_query_param === 'string' && media.encrypt_query_param.length > 0) {
    return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
  }
  throw new MediaError('media/no-url', 'media attachment has no download location')
}

/**
 * Identify a supported image from its magic bytes.
 *
 * WeChat does not provide a MIME type alongside an image item, and DSH validates
 * the declared type against the bytes it receives.
 *
 * @param {Buffer|Uint8Array} bytes - decrypted image bytes.
 * @returns {'image/jpeg'|'image/png'|'image/webp'|'image/gif'|undefined} media type.
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }
  const head = buffer.subarray(0, 6).toString('ascii')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/**
 * Download and decrypt inbound image media from the WeChat CDN.
 */
export class MediaDownloader {
  /**
   * @param {object} [options] - downloader options.
   * @param {string} [options.cdnBaseUrl] - CDN origin and path, normally the iLink default.
   * @param {Function} [options.fetchImpl] - fetch implementation, for tests.
   * @param {number} [options.maxImageBytes] - cap on downloaded ciphertext bytes.
   * @param {number} [options.timeoutMs] - total deadline for one download.
   * @param {string[]} [options.allowedHosts] - additional CDN hosts accepted for `full_url`.
   * @param {boolean} [options.allowHttp] - allow HTTP CDN URLs; tests only.
   * @param {object} [options.logger] - logger.
   */
  constructor({
    cdnBaseUrl = DEFAULT_CDN_BASE,
    fetchImpl = globalThis.fetch,
    maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
    timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
    allowedHosts = [],
    allowHttp = false,
    logger = { debug() {}, warn() {}, error() {} },
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) {
      throw new TypeError('maxImageBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('timeoutMs must be a positive safe integer')
    }

    this.allowHttp = allowHttp === true
    this.cdnBaseUrl = this.#normalizeCdnBase(cdnBaseUrl)
    this.fetchImpl = fetchImpl
    this.maxImageBytes = maxImageBytes
    this.timeoutMs = timeoutMs
    this.logger = logger

    const baseHost = new URL(this.cdnBaseUrl).hostname.toLowerCase()
    this.allowedHosts = new Set([
      baseHost,
      'cdn.weixin.qq.com',
      'novac2c.cdn.weixin.qq.com',
      ...allowedHosts.map((host) => String(host).toLowerCase()),
    ])
  }

  #normalizeCdnBase(value) {
    let url
    try {
      url = new URL(String(value))
    } catch (error) {
      throw new MediaError('media/invalid-cdn', 'cdnBaseUrl is not an absolute URL', { cause: error })
    }
    if (url.protocol !== 'https:' && !(this.allowHttp && url.protocol === 'http:')) {
      throw new MediaError('media/invalid-cdn', 'cdnBaseUrl must use https')
    }
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
      throw new MediaError('media/invalid-cdn', 'cdnBaseUrl must not carry credentials, a query, or a fragment')
    }
    return url.toString().replace(/\/+$/, '')
  }

  /**
   * Reject a URL outside the WeChat CDN host allowlist.
   *
   * @param {string} value - absolute URL.
   * @returns {void}
   * @throws {MediaError} when the URL is not an accepted HTTPS CDN location.
   */
  #assertUrl(value) {
    let url
    try {
      url = new URL(value)
    } catch (error) {
      throw new MediaError('media/blocked-url', 'media location is not an absolute URL', { cause: error })
    }
    if (url.protocol !== 'https:' && !(this.allowHttp && url.protocol === 'http:')) {
      throw new MediaError('media/blocked-url', 'media location must use https')
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new MediaError('media/blocked-url', 'media location must not carry credentials')
    }
    const host = url.hostname.toLowerCase()
    if (!this.allowedHosts.has(host) && !host.endsWith(CDN_HOST_SUFFIX)) {
      throw new MediaError('media/blocked-host', 'media location is not a WeChat CDN host')
    }
  }

  /**
   * Download bounded bytes from one accepted CDN URL.
   *
   * @param {string} url - CDN URL.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Buffer>} downloaded bytes.
   */
  async #download(url, signal) {
    this.#assertUrl(url)

    const deadline = AbortSignal.timeout(Math.min(this.timeoutMs, 2_147_483_647))
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: '*/*' },
        signal: combined,
      })
    } catch (error) {
      this.#throwFetchError(error, signal, deadline)
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new MediaError('media/http', `media download answered HTTP ${response.status}`, {
        status: response.status,
      })
    }

    // Followed redirects must remain on an accepted CDN host.
    this.#assertUrl(response.url || url)

    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > this.maxImageBytes) {
      await response.body?.cancel().catch(() => {})
      throw new MediaError('media/too-large', 'media attachment is too large', {
        bytes: declared,
        maxBytes: this.maxImageBytes,
      })
    }

    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer())
      this.#assertSize(bytes.length)
      return bytes
    }

    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > this.maxImageBytes) {
          await reader.cancel().catch(() => {})
          throw new MediaError('media/too-large', 'media attachment is too large', {
            bytes: total,
            maxBytes: this.maxImageBytes,
          })
        }
        chunks.push(chunk)
      }
    } catch (error) {
      if (error instanceof MediaError) throw error
      this.#throwFetchError(error, signal, deadline)
    }
    return Buffer.concat(chunks, total)
  }

  #assertSize(bytes) {
    if (bytes > this.maxImageBytes) {
      throw new MediaError('media/too-large', 'media attachment is too large', {
        bytes,
        maxBytes: this.maxImageBytes,
      })
    }
  }

  #throwFetchError(error, signal, deadline) {
    if (signal?.aborted) {
      throw new MediaError('media/aborted', 'media download was cancelled', { cause: error })
    }
    if (deadline.aborted) {
      throw new MediaError('media/timeout', 'media download timed out', { cause: error })
    }
    throw new MediaError('media/network', 'media download failed', { cause: error })
  }

  /**
   * Download and decrypt one image item.
   *
   * @param {object} image - `image_item` from an inbound message.
   * @param {object} [options] - download options.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<{data: Buffer, mediaType: string}>} decrypted image and its media type.
   * @throws {MediaError} when the item cannot be downloaded, decrypted, or classified.
   */
  async downloadImage(image, { signal } = {}) {
    if (image === null || typeof image !== 'object') {
      throw new MediaError('media/no-url', 'image attachment has no media object')
    }
    const media = image.media
    if (media === null || typeof media !== 'object') {
      throw new MediaError('media/no-url', 'image attachment has no media object')
    }

    const url = cdnDownloadUrl(media, this.cdnBaseUrl)
    const key = imageAesKey(image)
    const encrypted = await this.#download(url, signal)
    if (encrypted.length === 0) {
      throw new MediaError('media/empty', 'image attachment is empty')
    }

    const data = key === undefined ? encrypted : decryptAesEcb(encrypted, key)
    if (data.length === 0) {
      throw new MediaError('media/empty', 'image attachment is empty')
    }
    const mediaType = sniffImageMediaType(data)
    if (mediaType === undefined) {
      throw new MediaError(
        'media/unsupported-type',
        'image attachment is not a PNG, JPEG, WebP, or GIF image',
      )
    }

    this.logger.debug('inbound image downloaded', { bytes: data.length, mediaType })
    return { data, mediaType }
  }
}
