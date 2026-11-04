/**
 * Sender allowlist.
 *
 * Default deny: a WeChat user must present the one-time `/bind` code before any
 * message reaches the agent. The allowlist is a separate file so an operator can
 * inspect or revoke access without touching session state.
 *
 * @module dsh-weixin-gateway/store/allowed
 */

import { dirname, join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './atomic.mjs'

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
    this.#dirty = false
    this.#writing = Promise.resolve()
  }

  #dirty
  #writing

  /**
   * Load the allowlist from disk.
   *
   * @returns {Promise<void>} resolves once loaded.
   */
  async load() {
    const document = await readJson(this.file, null)
    if (document === null) return
    this.users = new Map(Object.entries(document.users ?? {}))
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
    if (this.users.has(userId)) return false
    this.users.set(userId, { boundAt: Date.now() })
    this.#dirty = true
    await this.flush()
    return true
  }

  /**
   * Revoke one sender.
   *
   * @param {string} userId - WeChat user id.
   * @returns {Promise<boolean>} true when a record was removed.
   */
  async revoke(userId) {
    if (!this.users.delete(userId)) return false
    this.#dirty = true
    await this.flush()
    return true
  }

  /**
   * Persist pending changes with the same coalescing rule as channel state.
   *
   * @returns {Promise<void>} resolves once persisted.
   */
  async flush() {
    const run = this.#writing.then(async () => {
      if (!this.#dirty) return
      this.#dirty = false
      try {
        await ensureDir(dirname(this.file))
        await writeJsonAtomic(
          this.file,
          { version: 1, users: Object.fromEntries(this.users) },
          { mode: 0o600 },
        )
      } catch (error) {
        this.#dirty = true
        throw error
      }
    })
    this.#writing = run.catch(() => {})
    return run
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
