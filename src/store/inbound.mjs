import { join } from 'node:path'
import { safeBotId } from './accounts.mjs'
import { readJson, writeJsonAtomic } from './atomic.mjs'

const MISSING = Symbol('missing')

export function inboundKey(userId, messageId) {
  return JSON.stringify([userId, String(messageId)])
}

function validateEntry(entry) {
  if (
    entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
    typeof entry.userId !== 'string' || entry.userId.length === 0 ||
    typeof entry.messageId !== 'string' || entry.messageId.length === 0 ||
    !['queued', 'submitting'].includes(entry.phase) ||
    !Number.isSafeInteger(entry.acceptedAt) || entry.acceptedAt < 0 ||
    (Object.hasOwn(entry, 'contextToken') && typeof entry.contextToken !== 'string')
  ) {
    throw new Error('Invalid inbound message tracking.')
  }
  return {
    userId: entry.userId,
    messageId: entry.messageId,
    phase: entry.phase,
    ...(Object.hasOwn(entry, 'contextToken') ? { contextToken: entry.contextToken } : {}),
    acceptedAt: entry.acceptedAt,
  }
}

export class InboundJournal {
  #botId
  #entries = new Map()
  #writing = Promise.resolve()
  #loaded = false

  constructor({ stateDir, botId }) {
    if (typeof botId !== 'string' || botId.length === 0) throw new TypeError('botId is required')
    this.#botId = botId
    this.file = join(stateDir, 'inbound', `${safeBotId(botId)}.json`)
  }

  load() {
    return this.#enqueue(() => this.#read())
  }

  entries() {
    return [...this.#entries.values()].map((entry) => ({ ...entry }))
  }

  has(userId, messageId) {
    return this.#entries.has(inboundKey(userId, messageId))
  }

  record({ fromUserId, messageId, contextToken }) {
    return this.#mutate(async () => {
      if (
        typeof messageId !== 'string' &&
        !(typeof messageId === 'number' && Number.isFinite(messageId))
      ) {
        throw new TypeError('Invalid inbound message identity.')
      }
      const key = inboundKey(fromUserId, messageId)
      if (this.#entries.has(key)) return false
      const entry = validateEntry({
        userId: fromUserId,
        messageId: String(messageId),
        phase: 'queued',
        ...(contextToken === undefined ? {} : { contextToken }),
        acceptedAt: Date.now(),
      })
      const entries = new Map(this.#entries)
      entries.set(key, entry)
      await this.#persist(entries)
      return true
    })
  }

  markSubmitting(userId, messageId) {
    return this.#mutate(async () => {
      const key = inboundKey(userId, messageId)
      const entry = this.#entries.get(key)
      if (entry === undefined) return false
      if (entry.phase === 'submitting') return true
      const entries = new Map(this.#entries)
      entries.set(key, { ...entry, phase: 'submitting' })
      await this.#persist(entries)
      return true
    })
  }

  remove(keys) {
    const identities = [...keys]
    return this.#mutate(async () => {
      const entries = new Map(this.#entries)
      let changed = false
      for (const key of identities) {
        if (entries.delete(key)) changed = true
      }
      if (changed) await this.#persist(entries)
    })
  }

  flush() {
    return this.#writing
  }

  #enqueue(operation) {
    const run = this.#writing.then(operation)
    this.#writing = run.catch(() => {})
    return run
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      if (!this.#loaded) await this.#read()
      return operation()
    })
  }

  async #read() {
    this.#loaded = false
    const document = await readJson(this.file, MISSING)
    const entries = new Map()
    if (document !== MISSING) {
      if (
        document === null || typeof document !== 'object' || Array.isArray(document) ||
        document.version !== 1 || document.botId !== this.#botId ||
        !Array.isArray(document.entries)
      ) {
        throw new Error('Invalid inbound message tracking.')
      }
      for (const value of document.entries) {
        const entry = validateEntry(value)
        const key = inboundKey(entry.userId, entry.messageId)
        if (entries.has(key)) throw new Error('Invalid inbound message tracking.')
        entries.set(key, entry)
      }
    }
    this.#entries = entries
    this.#loaded = true
  }

  async #persist(entries) {
    try {
      await writeJsonAtomic(this.file, {
        version: 1,
        botId: this.#botId,
        entries: [...entries.values()],
      }, { mode: 0o600 })
    } catch (cause) {
      const error = new Error('Could not persist inbound message tracking.', { cause })
      error.code = 'inbound-persistence'
      throw error
    }
    this.#entries = entries
  }
}
