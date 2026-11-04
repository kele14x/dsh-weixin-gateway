/**
 * Turn collector.
 *
 * Correlating a prompt with its answer is the delicate part of the integration.
 * `turn/end` carries only a turn number, and `user/message` carries the
 * client-minted request id but no turn number, so the collector:
 *
 * 1. remembers the latest `turn/start` per Session,
 * 2. matches our `user/message` by `source.rpcId === requestId`,
 * 3. pins that pending prompt to the remembered turn,
 * 4. accumulates every `assistant/message` belonging to that turn (a turn with
 *    tool calls produces several, one per step), and
 * 5. settles on the matching `turn/end`.
 *
 * Text blocks are filtered out of `message.content`; reasoning and tool-call
 * blocks must never reach WeChat.
 *
 * @module dsh-weixin-gateway/bridge/turn-collector
 */

import { silentLogger } from '../util/log.mjs'

/**
 * Extract visible text from one assistant message.
 *
 * @param {object} message - AssistantMessage.
 * @returns {string} concatenated text blocks.
 */
export function visibleText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Combine per-step texts according to the configured reply mode.
 *
 * @param {string[]} steps - visible text of each assistant step.
 * @param {'all'|'last'} [mode] - reply mode.
 * @returns {string} reply text.
 */
export function joinSteps(steps, mode = 'all') {
  const visible = steps.filter((step) => typeof step === 'string' && step.trim().length > 0)
  if (visible.length === 0) return ''
  if (mode === 'last') return visible[visible.length - 1]
  return visible.join('\n\n')
}

/** Collects assistant output for one in-flight prompt. */
export class TurnCollector {
  /**
   * @param {object} [options] - collector options.
   * @param {number} [options.timeoutMs] - default per-turn budget.
   * @param {object} [options.logger] - logger.
   */
  constructor({ timeoutMs = 600_000, logger = silentLogger } = {}) {
    this.timeoutMs = timeoutMs
    this.logger = logger
    /** @type {Map<string, object>} pending prompts keyed by session+request */
    this.pending = new Map()
    /** @type {Map<string, number>} latest opened turn per Session */
    this.lastTurn = new Map()
    this.disposeObserver = undefined
  }

  /**
   * Subscribe to host Session events.
   *
   * @param {{observe: (handler: Function) => Function}} host - host bridge.
   * @returns {void}
   */
  attach(host) {
    this.disposeObserver = host.observe((payload) => this.#onEvent(payload))
  }

  /**
   * Stop observing and fail every in-flight prompt.
   *
   * @returns {void}
   */
  dispose() {
    this.disposeObserver?.()
    this.disposeObserver = undefined
    for (const entry of this.pending.values()) {
      entry.fail(Object.assign(new Error('turn collector disposed'), { code: 'disposed' }))
    }
    this.pending.clear()
    this.lastTurn.clear()
  }

  /**
   * Start waiting for one prompt's turn.
   *
   * @param {object} options - wait options.
   * @param {string} options.sessionId - target Session.
   * @param {string} options.requestId - prompt request id.
   * @param {AbortSignal} [options.signal] - caller lifetime.
   * @param {number} [options.timeoutMs] - override budget.
   * @returns {{promise: Promise<object>, cancel: (code?: string) => void, sessionId: string, requestId: string}} handle.
   */
  begin({ sessionId, requestId, signal, timeoutMs = this.timeoutMs }) {
    const sid = String(sessionId)
    const key = `${sid}:${requestId}`

    if (this.pending.has(key)) {
      throw new Error(`duplicate prompt request id ${requestId}`)
    }

    let settle
    const promise = new Promise((resolve, reject) => {
      const entry = {
        sessionId: sid,
        requestId,
        turn: undefined,
        steps: [],
        interrupted: false,
        settled: false,
        resolve,
        reject,
        timer: undefined,
        cleanup: undefined,
      }

      entry.fail = (error) => {
        if (entry.settled) return
        entry.settled = true
        clearTimeout(entry.timer)
        entry.cleanup?.()
        this.pending.delete(key)
        reject(error)
      }

      entry.succeed = (value) => {
        if (entry.settled) return
        entry.settled = true
        clearTimeout(entry.timer)
        entry.cleanup?.()
        this.pending.delete(key)
        resolve(value)
      }

      entry.timer = setTimeout(() => {
        entry.fail(Object.assign(new Error('turn timed out'), { code: 'turn-timeout' }))
      }, Math.max(1, timeoutMs))
      entry.timer.unref?.()

      this.pending.set(key, entry)
      settle = entry

      if (signal) {
        const onAbort = () => {
          entry.fail(Object.assign(new Error('turn wait aborted'), { code: 'aborted' }))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
    })

    return {
      promise,
      sessionId: sid,
      requestId,
      cancel: (code = 'local-cancel') => {
        settle?.fail(Object.assign(new Error('turn wait cancelled'), { code }))
      },
    }
  }

  /**
   * Route one `session/event` notification.
   *
   * @param {{sessionId: string, event: object}} payload - host event.
   * @returns {void}
   */
  #onEvent({ sessionId, event }) {
    const sid = String(sessionId)
    const data = event?.data

    switch (event?.type) {
      case 'turn/start':
        this.lastTurn.set(sid, data?.turn)
        return
      case 'user/message': {
        const rpcId = data?.source?.rpcId
        if (typeof rpcId !== 'string') return
        const entry = this.pending.get(`${sid}:${rpcId}`)
        if (entry === undefined || entry.settled) return
        entry.matched = true
        entry.turn = this.lastTurn.get(sid)
        if (entry.turn === undefined) {
          this.logger.warn('prompt admitted without a preceding turn/start; adopting the next turn', {
            sessionId: sid,
          })
        }
        return
      }
      case 'assistant/message': {
        const turn = data?.turn
        for (const entry of this.pending.values()) {
          if (entry.sessionId !== sid || entry.settled) continue
          if (entry.turn === undefined) {
            if (entry.matched !== true) continue
            entry.turn = turn
          }
          if (entry.turn !== turn) continue
          if (data?.interrupted === true) entry.interrupted = true
          const text = visibleText(data?.message)
          if (text.length > 0) entry.steps.push(text)
        }
        return
      }
      case 'turn/end': {
        const turn = data?.turn
        for (const entry of this.pending.values()) {
          if (entry.sessionId !== sid || entry.settled) continue
          if (entry.turn === undefined) {
            if (entry.matched !== true) continue
            entry.turn = turn
          }
          if (entry.turn !== turn) continue
          entry.succeed({
            sessionId: sid,
            requestId: entry.requestId,
            turn,
            steps: entry.steps,
            interrupted: entry.interrupted,
            reason: data?.reason?.kind ?? 'completed',
            reasonDetail: data?.reason,
          })
        }
        return
      }
      default:
        return
    }
  }
}
