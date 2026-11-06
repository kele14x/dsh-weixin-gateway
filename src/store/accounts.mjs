/**
 * Bot credential storage.
 *
 * One file per bot account under `accounts/`, mode `0600`, never logged in raw
 * form. The token is the only secret the gateway needs at runtime.
 *
 * @module dsh-weixin-gateway/store/accounts
 */

import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { ensureDir, readJson, removeFile, writeJsonAtomic } from './atomic.mjs'

const SAFE_ID = /[^A-Za-z0-9._-]/g

/**
 * Make a bot id safe to use as a file name.
 *
 * @param {string} botId - server-supplied account id.
 * @returns {string} sanitized id.
 */
export function safeBotId(botId) {
  const cleaned = String(botId ?? '').replace(SAFE_ID, '_')
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'unknown'
  return cleaned.slice(0, 120)
}

/**
 * Mask a token for human-facing output.
 *
 * @param {string} token - raw token.
 * @returns {string} a short, non-reversible hint.
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '(none)'
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}…${token.slice(-2)}`
}

/** Credential store rooted at `<stateDir>/accounts`. */
export class AccountStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.stateDir - channel state root.
   */
  constructor({ stateDir }) {
    this.stateDir = stateDir
    this.dir = join(stateDir, 'accounts')
    this.activeFile = join(stateDir, 'active-account.json')
  }

  /**
   * Path of one account file.
   *
   * @param {string} botId - account id.
   * @returns {string} absolute path.
   */
  pathFor(botId) {
    return join(this.dir, `${safeBotId(botId)}.json`)
  }

  /**
   * Persist and activate one account, replacing any record for the same bot id.
   *
   * @param {object} account - credential record.
   * @param {string} account.botId - server account id.
   * @param {string} account.botToken - bearer token.
   * @param {string} account.baseUrl - API origin for this account.
   * @param {string} [account.ownerUserId] - WeChat user that scanned the QR.
   * @param {string} [account.botAgent] - observability token at login time.
   * @returns {Promise<string>} path written.
   */
  async save({ botId, botToken, baseUrl, ownerUserId, botAgent }) {
    if (typeof botId !== 'string' || botId.length === 0) throw new TypeError('botId is required')
    if (typeof botToken !== 'string' || botToken.length === 0) throw new TypeError('botToken is required')
    await ensureDir(this.dir)
    const record = {
      version: 1,
      botId,
      botToken,
      baseUrl,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      ...(botAgent === undefined ? {} : { botAgent }),
      savedAt: Date.now(),
    }
    const path = this.pathFor(botId)
    await writeJsonAtomic(path, record, { mode: 0o600 })
    await writeJsonAtomic(this.activeFile, { version: 1, botId }, { mode: 0o600 })
    return path
  }

  /**
   * Load one account by id.
   *
   * @param {string} botId - account id.
   * @returns {Promise<object|null>} the record, or null when absent.
   */
  async load(botId) {
    return readJson(this.pathFor(botId), null)
  }

  /**
   * Read every stored account.
   *
   * @returns {Promise<object[]>} records sorted by save time, newest first.
   */
  async list() {
    let entries
    try {
      entries = await readdir(this.dir)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const record = await readJson(join(this.dir, entry), null)
      if (record?.botToken) records.push(record)
    }
    return records.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  }

  /**
   * The explicitly selected account, used on startup.
   *
   * @returns {Promise<object|null>} selected record or null.
   */
  async active() {
    const selection = await readJson(this.activeFile, null)
    if (selection === null) return null
    if (selection.version !== 1 || typeof selection.botId !== 'string' || selection.botId.length === 0) {
      throw new Error(`unexpected active-account document shape in ${this.activeFile}`)
    }
    return this.load(selection.botId)
  }

  /**
   * Delete one account.
   *
   * @param {string} botId - account id.
   * @returns {Promise<void>} resolves once removed.
   */
  async remove(botId) {
    const selection = await readJson(this.activeFile, null)
    if (selection?.botId === botId) await removeFile(this.activeFile)
    await removeFile(this.pathFor(botId))
  }
}
