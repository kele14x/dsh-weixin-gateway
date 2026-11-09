/**
 * AES helpers for WeChat CDN media.
 *
 * The iLink CDN encrypts media with AES-128-ECB and PKCS#7 padding. The AES key
 * reaches the client in three different encodings, all of which are accepted
 * here:
 *
 * - `image_item.aeskey`: 32 hexadecimal characters.
 * - `media.aes_key`: base64 of the 16 raw key bytes.
 * - `media.aes_key`: base64 of a 32-character hexadecimal key string.
 *
 * Control characters and key material never appear in error messages.
 *
 * @module dsh-weixin-gateway/media/crypto
 */

import { createDecipheriv, createCipheriv } from 'node:crypto'
import { MediaError } from './errors.mjs'

const HEX_KEY = /^[0-9a-fA-F]{32}$/

/**
 * Parse one CDN AES key into 16 raw bytes.
 *
 * @param {unknown} value - base64 or hexadecimal key material.
 * @param {string} [label] - diagnostic label without secrets.
 * @returns {Buffer} 16-byte AES key.
 * @throws {MediaError} when the key cannot be recognized.
 */
export function parseAesKey(value, label = 'media') {
  if (Buffer.isBuffer(value) && value.length === 16) return value
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MediaError('media/invalid-key', `${label} attachment has no usable AES key`)
  }
  const text = value.trim()
  if (HEX_KEY.test(text)) return Buffer.from(text, 'hex')

  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && HEX_KEY.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new MediaError('media/invalid-key', `${label} attachment has an unrecognized AES key`)
}

/**
 * Resolve the AES key for one inbound image item.
 *
 * An explicit `image_item.aeskey` takes precedence over `media.aes_key`. When
 * neither is present, the image may be unencrypted and the caller uses the
 * downloaded bytes as plaintext.
 *
 * @param {object} image - `image_item`.
 * @returns {Buffer|undefined} key, or undefined for a plaintext image.
 * @throws {MediaError} when a declared key is malformed.
 */
export function imageAesKey(image) {
  if (typeof image?.aeskey === 'string' && image.aeskey.length > 0) {
    if (!HEX_KEY.test(image.aeskey)) {
      throw new MediaError('media/invalid-key', 'image attachment has an invalid aeskey')
    }
    return Buffer.from(image.aeskey, 'hex')
  }
  if (typeof image?.media?.aes_key === 'string' && image.media.aes_key.length > 0) {
    return parseAesKey(image.media.aes_key, 'image')
  }
  return undefined
}

/**
 * Decrypt one AES-128-ECB ciphertext with PKCS#7 padding.
 *
 * @param {Buffer} ciphertext - encrypted bytes.
 * @param {Buffer} key - 16-byte key.
 * @returns {Buffer} plaintext.
 * @throws {MediaError} when the key or padding is invalid.
 */
export function decryptAesEcb(ciphertext, key) {
  if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(key) || key.length !== 16) {
    throw new MediaError('media/invalid-key', 'media attachment cannot be decrypted with this key')
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    throw new MediaError('media/decrypt', 'media attachment could not be decrypted', { cause: error })
  }
}

/**
 * Encrypt one buffer with AES-128-ECB and PKCS#7 padding.
 *
 * Reserved for the outbound media phase; kept beside decryption so both
 * directions share one crypto implementation.
 *
 * @param {Buffer} plaintext - bytes to encrypt.
 * @param {Buffer} key - 16-byte key.
 * @returns {Buffer} ciphertext.
 */
export function encryptAesEcb(plaintext, key) {
  if (!Buffer.isBuffer(plaintext) || !Buffer.isBuffer(key) || key.length !== 16) {
    throw new MediaError('media/invalid-key', 'media attachment cannot be encrypted with this key')
  }
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * Ciphertext size after AES-128-ECB PKCS#7 padding.
 *
 * @param {number} plaintextSize - plaintext byte count.
 * @returns {number} padded ciphertext byte count.
 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}
