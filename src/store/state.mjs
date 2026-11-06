/**
 * Durable channel state: the long-poll cursor, per-sender context tokens, the
 * WeChat-user to DSH-session mapping, and a bounded dedupe window.
 *
 * The file is the only place the cursor and context tokens live, so writes are
 * serialized, atomic, and mode `0600`. A corrupt file is reported instead of
 * being silently replaced: overwriting it would drop every session mapping.
 *
 * @module dsh-weixin-gateway/store/state
 */

import { join } from 'node:path'
import { ensureDir, readJson, writeJsonAtomic } from './atomic.mjs'
import { silentLogger } from '../util/log.mjs'

const DEFAULT_DEDUPE_TTL_MS = 60 * 60 * 1000
const DEFAULT_DEDUPE_LIMIT = 500

/**
 * Normalize a dedupe key. Message ids are only unique per sender.
 *
 * @param {string} userId - sender id.
 * @param {string|number} messageId - server message id.
 * @returns {string} stable key.
 */
function dedupeKey(userId, messageId) {
  return `${userId}:${String(messageId)}`
}

/** Per-account channel state. */
export class ChannelState {
  /**
   * @param {object} options - state options.
   * @param {string} options.stateDir - channel state root.
   * @param {string} options.botId - account the state belongs to.
   * @param {number} [options.dedupeTtlMs] - how long a message id is remembered.
   * @param {number} [options.dedupeLimit] - hard cap on remembered ids.
   * @param {object} [options.logger] - logger.
   */
  constructor({
    stateDir,
    botId,
    dedupeTtlMs = DEFAULT_DEDUPE_TTL_MS,
    dedupeLimit = DEFAULT_DEDUPE_LIMIT,
    logger = silentLogger,
  }) {
    this.stateDir = stateDir
    this.botId = botId
    this.dir = join(stateDir, 'state')
    this.file = join(this.dir, `${String(botId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
    this.dedupeTtlMs = dedupeTtlMs
    this.dedupeLimit = dedupeLimit
    this.logger = logger

    this.cursor = ''
    this.contextTokens = new Map()
    this.sessions = new Map()
    /** @type {Map<string, number>} */
    this.seen = new Map()

    this.#dirty = false
    this.#writing = Promise.resolve()
  }

  #dirty
  #writing

  /**
   * Read state from disk.
   *
   * @returns {Promise<void>} resolves once loaded.
   * @throws {import('./atomic.mjs').StateCorruptError} when the file is unreadable.
   */
  async load() {
    const document = await readJson(this.file, null)
    if (document === null) return
    if (typeof document !== 'object' || Array.isArray(document)) {
      throw new Error(`unexpected state document shape in ${this.file}`)
    }
    this.cursor = typeof document.cursor === 'string' ? document.cursor : ''
    this.contextTokens = new Map(Object.entries(document.contextTokens ?? {}))
    this.sessions = new Map(Object.entries(document.sessions ?? {}))
    const now = Date.now()
    this.seen = new Map(
      (Array.isArray(document.dedupe) ? document.dedupe : []).filter(
        (entry) => Array.isArray(entry) && now - Number(entry[1]) < this.dedupeTtlMs,
      ),
    )
  }

  /**
   * Persist pending changes, coalescing concurrent callers.
   *
   * @returns {Promise<void>} resolves after the write that observed the change.
   */
  async flush() {
    const run = this.#writing.then(async () => {
      if (!this.#dirty) return
      this.#dirty = false
      try {
        await ensureDir(this.dir)
        await writeJsonAtomic(
          this.file,
          {
            version: 1,
            botId: this.botId,
            cursor: this.cursor,
            contextTokens: Object.fromEntries(this.contextTokens),
            sessions: Object.fromEntries(this.sessions),
            dedupe: [...this.seen.entries()],
          },
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
   * Record the next long-poll cursor. An empty cursor is ignored: the protocol
   * only requires persistence when the server returns a non-empty value.
   *
   * @param {string} cursor - server cursor.
   * @returns {Promise<void>} resolves once persisted.
   */
  async setCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length === 0) return
    if (cursor !== this.cursor) {
      this.cursor = cursor
      this.#dirty = true
    }
    await this.flush()
  }

  /**
   * Latest context token for a sender, used on every outbound reply.
   *
   * @param {string} userId - sender id.
   * @returns {string|undefined} token when known.
   */
  contextTokenFor(userId) {
    return this.contextTokens.get(userId)
  }

  /**
   * Remember a sender's newest context token.
   *
   * @param {string} userId - sender id.
   * @param {string} token - context token from the inbound message.
   * @returns {Promise<void>} resolves once persisted.
   */
  async setContextToken(userId, token) {
    if (typeof token !== 'string' || token.length === 0) return
    if (this.contextTokens.get(userId) !== token) {
      this.contextTokens.set(userId, token)
      this.#dirty = true
    }
    await this.flush()
  }

  /**
   * Stored DSH session mapping for a sender.
   *
   * @param {string} userId - sender id.
   * @returns {{sessionId: string, cwd: string, createdAt: number, lastSeen: number}|undefined} mapping.
   */
  sessionFor(userId) {
    return this.sessions.get(userId)
  }

  /**
   * Replace a sender's session mapping.
   *
   * @param {string} userId - sender id.
   * @param {{sessionId: string, cwd: string, createdAt?: number, lastSeen?: number}} record - mapping.
   * @returns {Promise<void>} resolves once persisted.
   */
  async setSession(userId, record) {
    const now = Date.now()
    this.sessions.set(userId, {
      sessionId: record.sessionId,
      cwd: record.cwd,
      createdAt: record.createdAt ?? now,
      lastSeen: record.lastSeen ?? now,
    })
    this.#dirty = true
    await this.flush()
  }

  /**
   * Update the last-seen time for a mapping without creating one.
   *
   * @param {string} userId - sender id.
   * @returns {Promise<void>} resolves once persisted.
   */
  async touchSession(userId) {
    const record = this.sessions.get(userId)
    if (record === undefined) return
    record.lastSeen = Date.now()
    this.#dirty = true
    await this.flush()
  }

  /**
   * Drop a sender's mapping (used by `/new` after creating a replacement).
   *
   * @param {string} userId - sender id.
   * @returns {Promise<void>} resolves once persisted.
   */
  async dropSession(userId) {
    if (!this.sessions.delete(userId)) return
    this.#dirty = true
    await this.flush()
  }

  /**
   * Check and record an inbound message id.
   *
   * @param {string} userId - sender id.
   * @param {string|number} messageId - server message id.
   * @returns {boolean} true when this id was already seen.
   */
  isDuplicate(userId, messageId) {
    const key = dedupeKey(userId, messageId)
    const now = Date.now()
    const previous = this.seen.get(key)
    if (previous !== undefined && now - previous < this.dedupeTtlMs) return true

    this.seen.delete(key)
    this.seen.set(key, now)
    this.#pruneSeen(now)
    this.#dirty = true
    return false
  }

  #pruneSeen(now) {
    for (const [key, at] of this.seen) {
      if (now - at >= this.dedupeTtlMs) this.seen.delete(key)
    }
    while (this.seen.size > this.dedupeLimit) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
  }

  /**
   * Non-secret summary for `/status`.
   *
   * @returns {{botId: string, cursorLength: number, sessions: number, contextTokens: number}} summary.
   */
  summary() {
    return {
      botId: this.botId,
      cursorLength: this.cursor.length,
      sessions: this.sessions.size,
      contextTokens: this.contextTokens.size,
    }
  }
}
