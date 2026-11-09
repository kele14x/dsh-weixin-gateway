/**
 * Sender allowlist.
 *
 * Default deny: a WeChat user must present the one-time `/bind` code before any
 * message reaches the agent. The allowlist is a separate file so an operator can
 * inspect or revoke access without touching session state.
 *
 * @module dsh-weixin-gateway/store/allowed
 */

import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './atomic.mjs'
import { codeFingerprint } from './pairing.mjs'

/** Sender allowlist rooted at `<stateDir>/allowed.json`. */
export class AllowList {
  /**
   * @param {object} options - allowlist options.
   * @param {string} options.stateDir - channel state root.
   */
  constructor({ stateDir }) {
    this.file = join(stateDir, 'allowed.json')
    /** @type {Map<string, {boundAt: number}>} */
    this.users = new Map()
    this.#consumedCodeHashes = new Set()
    this.#writing = Promise.resolve()
  }

  #consumedCodeHashes
  #writing

  /**
   * Load the allowlist from disk.
   *
   * @returns {Promise<void>} resolves once loaded.
   */
  async load() {
    return this.#enqueue(async () => {
      const document = await readJson(this.file, null)
      if (document === null) return
      const users = new Map(Object.entries(document.users ?? {}))
      const consumedCodeHashes = new Set(document.consumedCodeHashes ?? [])
      this.users = users
      this.#consumedCodeHashes = consumedCodeHashes
    })
  }

  /**
   * Whether a sender has paired with this bot.
   *
   * @param {string} userId - WeChat user id.
   * @returns {boolean} true when allowed.
   */
  isAllowed(userId) {
    return this.users.has(userId)
  }

  /**
   * Add one sender.
   *
   * @param {string} userId - WeChat user id.
   * @returns {Promise<boolean>} true when newly added.
   */
  async allow(userId) {
    return this.#enqueue(async () => {
      if (this.users.has(userId)) return false
      const users = new Map(this.users)
      users.set(userId, { boundAt: Date.now() })
      await this.#persist(users, this.#consumedCodeHashes)
      return true
    })
  }

  /**
   * Whether a code with this fingerprint has been redeemed.
   *
   * @param {string} fingerprint - hex SHA-256 of the code.
   * @returns {boolean} true when consumed.
   */
  hasConsumed(fingerprint) {
    return this.#consumedCodeHashes.has(fingerprint)
  }

  async redeem(userId, code) {
    if (typeof code !== 'string' || code.length === 0) return false
    const fingerprint = codeFingerprint(code)
    return this.#enqueue(async () => {
      if (this.users.has(userId) || this.#consumedCodeHashes.has(fingerprint)) return false
      const users = new Map(this.users)
      const consumedCodeHashes = new Set(this.#consumedCodeHashes)
      users.set(userId, { boundAt: Date.now() })
      consumedCodeHashes.add(fingerprint)
      await this.#persist(users, consumedCodeHashes)
      return true
    })
  }

  /**
   * Revoke one sender.
   *
   * @param {string} userId - WeChat user id.
   * @returns {Promise<boolean>} true when a record was removed.
   */
  async revoke(userId) {
    return this.#enqueue(async () => {
      if (!this.users.has(userId)) return false
      const users = new Map(this.users)
      users.delete(userId)
      await this.#persist(users, this.#consumedCodeHashes)
      return true
    })
  }

  /**
   * Wait for queued mutations to persist.
   *
   * @returns {Promise<void>} resolves once persisted.
   */
  async flush() {
    return this.#enqueue(() => {})
  }

  #enqueue(operation) {
    const run = this.#writing.then(operation)
    this.#writing = run.catch(() => {})
    return run
  }

  async #persist(users, consumedCodeHashes) {
    await writeJsonAtomic(
      this.file,
      { version: 1, users: Object.fromEntries(users), consumedCodeHashes: [...consumedCodeHashes] },
      { mode: 0o600 },
    )
    this.users = users
    this.#consumedCodeHashes = consumedCodeHashes
  }

  /**
   * Number of paired senders.
   *
   * @returns {number} count.
   */
  get size() {
    return this.users.size
  }
}
