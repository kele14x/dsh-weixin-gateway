/**
 * Operator-issued pairing codes.
 *
 * `dsh-weixin pair` writes `<stateDir>/pairing.json`; the running gateway reads
 * it on every `/bind`, so issuing or rotating a code needs no Host restart. Only
 * the SHA-256 of the code is stored, and it equals the allowlist's consumed-code
 * fingerprint, so a redeemed code cannot be replayed.
 *
 * @module dsh-weixin-gateway/store/pairing
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readJson, removeFile, writeJsonAtomic } from './atomic.mjs'

// Lowercase without look-alikes (i, l, o, 0, 1) so the code is easy to type on a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 8
export const PAIRING_TTL_MS = 15 * 60 * 1000

/**
 * @param {string} stateDir - channel state root.
 * @returns {string} pairing file path.
 */
export function pairingFile(stateDir) {
  return join(stateDir, 'pairing.json')
}

/**
 * @param {string} code - pairing code.
 * @returns {string} hex SHA-256 fingerprint.
 */
export function codeFingerprint(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * Generate a code and replace any pending one.
 *
 * @param {string} stateDir - channel state root.
 * @param {{now?: number, ttlMs?: number}} [options] - clock and lifetime.
 * @returns {Promise<{code: string, expiresAt: number}>} the plaintext code, shown once.
 */
export async function issuePairingCode(stateDir, { now = Date.now(), ttlMs = PAIRING_TTL_MS } = {}) {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  const expiresAt = now + ttlMs
  await writeJsonAtomic(pairingFile(stateDir), { version: 1, codeHash: codeFingerprint(code), expiresAt }, { mode: 0o600 })
  return { code, expiresAt }
}

/**
 * Read the pending code record.
 *
 * @param {string} stateDir - channel state root.
 * @returns {Promise<{codeHash: string, expiresAt: number}|null>} record, or null when none is stored.
 * @throws {import('./atomic.mjs').StateCorruptError} when the file is not valid JSON.
 */
export async function readPairingCode(stateDir) {
  const document = await readJson(pairingFile(stateDir), null)
  if (
    document === null ||
    typeof document.codeHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(document.codeHash) ||
    !Number.isFinite(document.expiresAt)
  ) {
    return null
  }
  return { codeHash: document.codeHash, expiresAt: document.expiresAt }
}

/**
 * Normalize a candidate the way generated codes are compared.
 *
 * @param {string} candidate - code typed by the sender.
 * @returns {string} normalized code.
 */
export function normalizePairingCode(candidate) {
  return candidate.toLowerCase()
}

/**
 * Compare a normalized candidate against a stored fingerprint in constant time.
 *
 * @param {string} candidate - normalized candidate code.
 * @param {string} codeHash - stored hex fingerprint.
 * @returns {boolean} true when they match.
 */
export function matchesPairingCode(candidate, codeHash) {
  return timingSafeEqual(Buffer.from(codeFingerprint(candidate), 'hex'), Buffer.from(codeHash, 'hex'))
}

/**
 * Remove any pending code.
 *
 * @param {string} stateDir - channel state root.
 * @returns {Promise<void>} resolves once removed.
 */
export async function clearPairingCode(stateDir) {
  await removeFile(pairingFile(stateDir))
}
