/**
 * Gateway runtime.
 *
 * Owns the long poll, the per-sender queue, the one-session-per-sender mapping,
 * and the reply path. Failure policy follows the design document:
 *
 * - a `-14` response pauses the account for one hour and then retries;
 * - a poller lock held by another Host is retried until it is released;
 * - a network failure backs off with the cursor untouched;
 * - a turn that ends without text still produces a notice;
 * - nothing is ever reported as a successful answer when it was not.
 *
 * @module dsh-weixin-gateway/runtime
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { splitText } from './util/chunk.mjs'
import { sleep, raceAbort } from './util/time.mjs'
import { silentLogger } from './util/log.mjs'
import { normalizeInbound, isGroupMessage } from './ilink/messages.mjs'
import { ILinkClient } from './ilink/client.mjs'
import { TYPING_START, TYPING_STOP, VERSION, botAgentFor } from './ilink/constants.mjs'
import { acquireLock, LockError } from './store/lock.mjs'
import { AccountStore, safeBotId } from './store/accounts.mjs'
import { ChannelState } from './store/state.mjs'
import { AllowList } from './store/allowed.mjs'
import { CommandRouter, parseCommand } from './bridge/commands.mjs'
import { SessionRouter } from './bridge/session-router.mjs'
import { TurnCollector, joinSteps } from './bridge/turn-collector.mjs'

/** Maximum characters of an upstream error message echoed to WeChat. */
const MAX_ERROR_CHARS = 300

/**
 * Shorten a value for human-facing output.
 *
 * @param {string} value - text to shorten.
 * @param {number} [max] - maximum length.
 * @returns {string} shortened text.
 */
function shorten(value, max = MAX_ERROR_CHARS) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Runtime state machine for one bot account. */
export class Gateway {
  /**
   * @param {object} options - runtime options.
   * @param {object} options.config - resolved plugin config.
   * @param {object} options.host - host bridge.
   * @param {object} [options.logger] - logger.
   * @param {object} [options.accounts] - account store override.
   * @param {Function} [options.clientFactory] - client factory override for tests.
   * @param {number} [options.lockRetryMs] - delay before retrying a poller lock held elsewhere.
   * @param {number} [options.pauseHeartbeatMs] - lock heartbeat interval during a `-14` pause.
   */
  constructor({
    config,
    host,
    logger = silentLogger,
    accounts,
    clientFactory,
    lockRetryMs = 30_000,
    pauseHeartbeatMs = 60_000,
  }) {
    this.config = config
    this.host = host
    this.logger = logger
    this.accounts = accounts ?? new AccountStore({ stateDir: config.stateDir })
    this.clientFactory =
      clientFactory ??
      ((options) => new ILinkClient({ ...options, pollTimeoutMs: config.pollTimeoutMs }))
    this.lockRetryMs = lockRetryMs
    this.pauseHeartbeatMs = pauseHeartbeatMs
    this.lockRetryTimer = undefined
    this.startPromise = undefined
    this.stopPromise = undefined
    this.drainPromises = new Set()

    /** @type {'stopped'|'starting'|'unconfigured'|'locked'|'running'|'paused'|'stopping'|'error'} */
    this.status = 'stopped'
    this.account = undefined
    this.client = undefined
    this.lock = undefined
    this.state = undefined
    this.allowed = undefined
    this.router = undefined
    this.collector = undefined
    this.commands = undefined
    this.abort = undefined
    this.pollPromise = undefined
    this.lastPollAt = 0
    this.startedAt = 0
    this.pollTimeoutMs = config.pollTimeoutMs

    /** @type {Map<string, object[]>} queued messages per sender */
    this.queues = new Map()
    /** @type {Set<string>} senders with a draining queue */
    this.draining = new Set()
    /** @type {Map<string, object>} active turn per sender */
    this.active = new Map()
    /** @type {Map<string, {ticket: string, at: number}>} typing tickets */
    this.typingTickets = new Map()
    /** @type {Set<string>} senders whose aborted-turn notice is suppressed */
    this.suppressAbort = new Set()
    /** @type {Map<string, number>} last unpaired-hint time per sender */
    this.unpairedHintAt = new Map()
  }

  /**
   * Start the channel. A missing credential disables the channel instead of
   * failing the Host process; a lock conflict does the same with a diagnostic,
   * then retries, so this Host adopts the account when the other owner exits.
   *
   * @returns {Promise<void>} resolves once polling started or the channel disabled itself.
   */
  start() {
    if (this.startPromise) return this.startPromise
    if (this.status === 'error') return this.stop().then(() => this.start())
    if (this.status !== 'stopped' && this.status !== 'locked') return Promise.resolve()
    const starting = this.#start()
    this.startPromise = starting
    const clear = () => {
      if (this.startPromise === starting) this.startPromise = undefined
    }
    starting.then(clear, clear)
    return starting
  }

  async #start() {
    const retrying = this.status === 'locked'
    this.#clearLockRetry()
    this.status = 'starting'
    this.startedAt = Date.now()
    this.abort = new AbortController()
    const signal = this.abort.signal

    try {
      const account = await raceAbort(this.accounts.active(), signal)
      if (account === null) {
        this.status = 'unconfigured'
        this.logger.warn(
          'no active WeChat account is selected; run `dsh-weixin login` (or `npx dsh-weixin login`) and restart the Host',
          { stateDir: this.config.stateDir },
        )
        return
      }
      this.account = account

      try {
        this.lock = await acquireLock(
          join(this.config.stateDir, 'lock', `${safeBotId(account.botId)}.lock`),
          { logger: this.logger },
        )
      } catch (error) {
        if (signal.aborted) throw error
        if (error?.code === 'locked') {
          // One bot token may have exactly one poller. Refuse instead of racing
          // the running instance into a `-14` pause, but keep checking: the
          // other Host may be a manual run that exits shortly.
          this.status = 'locked'
          if (retrying) {
            this.logger.debug('poller lock is still held elsewhere', { holder: error.holder })
          } else {
            this.logger.error(
              'another gateway process owns this bot account; refusing to poll (single-poller rule)',
              { holder: error.holder },
            )
          }
          this.#scheduleLockRetry()
          return
        }
        throw error
      }

      signal.throwIfAborted()
      this.state = new ChannelState({
        stateDir: this.config.stateDir,
        botId: account.botId,
        logger: this.logger,
      })
      await this.state.load()

      this.allowed = new AllowList({ stateDir: this.config.stateDir })
      await this.allowed.load()
      signal.throwIfAborted()

      this.client = this.clientFactory({
        baseUrl: account.baseUrl ?? this.config.baseUrl,
        botToken: account.botToken,
        botAgent: this.config.botAgent ?? account.botAgent ?? botAgentFor(VERSION),
        pollTimeoutMs: this.config.pollTimeoutMs,
        logger: this.logger,
      })

      this.collector = new TurnCollector({ timeoutMs: this.config.turnTimeoutMs, logger: this.logger })
      this.collector.attach(this.host)

      this.router = new SessionRouter({
        host: this.host,
        state: this.state,
        defaultCwd: this.config.defaultCwd,
        agentPreset: this.config.agentPreset,
        logger: this.logger,
      })

      this.commands = new CommandRouter({
        actions: {
          status: (userId) => this.statusText(userId),
          stop: (userId) => this.stopTurn(userId),
          newSession: (userId) => this.newSession(userId),
          version: () => `dsh-weixin-gateway ${VERSION} (iLink protocol reference 2.4.10)`,
        },
        allowed: this.allowed,
        config: this.config,
        logger: this.logger,
      })

      this.status = 'running'
      this.logger.info('gateway started', {
        botId: account.botId,
        baseUrl: this.client.baseUrl,
        sessionCount: this.state.summary().sessions,
        pairedSenders: this.allowed.size,
      })

      this.#notifyLifecycle('notifyStart')
      this.pollPromise = this.#pollLoop()
    } catch (error) {
      await this.lock?.release().catch(() => {})
      this.lock = undefined
      if (signal.aborted) return
      this.status = 'error'
      throw error
    }
  }

  /**
   * Stop polling, fail in-flight turns, persist state, and release the lock.
   *
   * @returns {Promise<void>} resolves once shutdown finished.
   */
  stop() {
    if (this.stopPromise) return this.stopPromise
    if (this.status === 'stopped') return Promise.resolve()
    const stopping = this.#stop()
    this.stopPromise = stopping
    const clear = () => {
      if (this.stopPromise === stopping) this.stopPromise = undefined
    }
    stopping.then(clear, clear)
    return stopping
  }

  async #stop() {
    this.#clearLockRetry()
    const wasRunning = this.status === 'running' || this.status === 'paused'
    this.status = 'stopping'
    this.abort?.abort()
    for (const active of this.active.values()) {
      active.controller.abort()
      if (active.phase !== 'preparing') {
        try {
          this.host.cancel({ sessionId: active.sessionId })
        } catch (error) {
          this.logger.error('could not cancel a turn during shutdown', error)
        }
      }
    }
    for (const queue of this.queues.values()) queue.length = 0
    this.queues.clear()
    await this.startPromise?.catch(() => {})
    await this.pollPromise?.catch(() => {})
    this.pollPromise = undefined
    await Promise.allSettled([...this.drainPromises])
    this.collector?.dispose()
    this.active.clear()
    this.suppressAbort.clear()

    if (wasRunning) await this.#notifyLifecycle('notifyStop')
    await this.state?.flush().catch((error) => {
      this.logger.error('failed to flush channel state', error)
    })
    await this.lock?.release().catch((error) => {
      this.logger.warn('failed to release poller lock', { reason: error.message })
    })
    this.lock = undefined
    this.status = 'stopped'
    this.logger.info('gateway stopped')
  }

  /**
   * Poll the lock again after a conflict, so a Host that started second is not
   * inert forever. The timer is unref'd: it never keeps the process alive, and
   * `stop()` cancels it.
   *
   * @returns {void}
   */
  #scheduleLockRetry() {
    if (this.lockRetryTimer !== undefined) return
    const timer = setTimeout(() => {
      this.lockRetryTimer = undefined
      if (this.status !== 'locked') return
      this.start().catch((error) => {
        this.logger.error('poller lock retry failed', error)
      })
    }, this.lockRetryMs)
    timer.unref?.()
    this.lockRetryTimer = timer
  }

  /** Cancel a pending lock retry. */
  #clearLockRetry() {
    if (this.lockRetryTimer === undefined) return
    clearTimeout(this.lockRetryTimer)
    this.lockRetryTimer = undefined
  }

  /**
   * Non-secret runtime summary for `/status` and diagnostics.
   *
   * @returns {object} summary.
   */
  summary() {
    return {
      status: this.status,
      botId: this.account?.botId,
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
      lastPollAt: this.lastPollAt,
      queuedSenders: this.queues.size,
      activeTurns: this.active.size,
      sessionCount: this.state?.summary().sessions ?? 0,
      pairedSenders: this.allowed?.size ?? 0,
    }
  }

  /**
   * Format `/status` for one sender.
   *
   * @param {string} userId - sender id.
   * @returns {string} status text.
   */
  statusText(userId) {
    const session = this.state?.sessionFor(userId)
    const active = this.active.get(userId)
    const queued = this.queues.get(userId)?.length ?? 0
    const lines = [
      `account: ${this.account?.botId ?? 'none'}`,
      `gateway: ${this.status}`,
      `session: ${session?.sessionId ?? 'none'}`,
      `turn: ${active === undefined ? 'idle' : 'running'}`,
      `cwd: ${session?.cwd ?? this.config.defaultCwd}`,
      `queue: ${queued}`,
      `paired senders: ${this.allowed?.size ?? 0}`,
    ]
    if (this.lastPollAt > 0) {
      lines.push(`last poll: ${new Date(this.lastPollAt).toISOString()}`)
    }
    return lines.join('\n')
  }

  /**
   * Handle `/stop`: cancel the active turn and drop queued messages.
   *
   * @param {string} userId - sender id.
   * @returns {string} reply text.
   */
  stopTurn(userId) {
    const active = this.active.get(userId)
    this.queues.delete(userId)
    if (active === undefined) return 'Nothing is running.'
    this.suppressAbort.add(userId)
    try {
      if (active.phase !== 'preparing') this.host.cancel({ sessionId: active.sessionId })
      active.controller.abort()
      if (active.keepActive) {
        active.keepActive = false
        if (!this.draining.has(userId)) {
          this.active.delete(userId)
          this.suppressAbort.delete(userId)
        }
      }
      this.logger.info('cancellation requested', { userId, sessionId: active.sessionId })
    } catch (error) {
      this.suppressAbort.delete(userId)
      this.logger.error('cancellation failed', error)
      return `Could not cancel the running turn: ${shorten(error.message)}`
    }
    return 'Stopping the current turn and clearing the queue.'
  }

  /**
   * Handle `/new`: create a fresh Session and replace the mapping.
   *
   * @param {string} userId - sender id.
   * @returns {Promise<string>} reply text.
   */
  async newSession(userId) {
    const created = await this.router.reset(userId)
    return `Started a new DSH session: ${created.sessionId}\nThe previous session and its history are kept.`
  }

  /**
   * Wait until no turn is running and every queue is drained. Used by tests and
   * by shutdown-oriented diagnostics.
   *
   * @param {object} [options] - wait options.
   * @param {number} [options.timeoutMs] - budget.
   * @param {number} [options.intervalMs] - poll interval.
   * @returns {Promise<boolean>} true when the gateway became quiet.
   */
  async waitForQuiet({ timeoutMs = 5000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const queued = [...this.queues.values()].some((queue) => queue.length > 0)
      if (!queued && this.draining.size === 0 && this.active.size === 0) return true
      await sleep(intervalMs)
    }
    return false
  }

  /** Long-poll loop with backoff and the one-hour `-14` pause. */
  async #pollLoop() {
    let backoff = 1000
    while (this.status === 'running' || this.status === 'paused') {
      try {
        const batch = await this.client.getUpdates({
          cursor: this.state.cursor,
          signal: this.abort.signal,
          timeoutMs: this.pollTimeoutMs,
        })
        if (this.status === 'stopping' || this.abort.signal.aborted) break

        this.lastPollAt = Date.now()
        backoff = 1000

        if (typeof batch.longPollingTimeoutMs === 'number' && batch.longPollingTimeoutMs > 0) {
          this.pollTimeoutMs = batch.longPollingTimeoutMs
        }
        await this.lock.touch()

        for (const raw of batch.msgs) {
          if (this.abort.signal.aborted) break
          try {
            await this.#accept(raw)
          } catch (error) {
            if (this.abort.signal.aborted) break
            this.logger.error('failed to handle an inbound message', error)
            const message = normalizeInbound(raw)
            if (message) await this.#sendText(message.fromUserId, `Could not process this message: ${shorten(error.message)}`)
          }
        }
        if (!this.abort.signal.aborted && batch.getUpdatesBuf !== undefined) {
          await this.state.setCursor(batch.getUpdatesBuf)
        }
      } catch (error) {
        if (this.abort.signal.aborted || error.code === 'aborted') break
        if (error.code === 'locked') {
          this.logger.error('poller lock ownership was lost; stopping polling', error)
          this.status = 'error'
          this.abort.abort()
          break
        }
        if (error.code === 'session-paused') {
          await this.#pauseForSession().catch((pauseError) => {
            this.logger.error('could not maintain the poller lock during the pause', pauseError)
            this.status = 'error'
            this.abort.abort()
          })
          continue
        }
        this.logger.error('getUpdates failed; backing off', error)
        try {
          await sleep(backoff, this.abort.signal)
        } catch {
          break
        }
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  /** Pause polling for the documented one-hour `-14` window. */
  async #pauseForSession() {
    this.status = 'paused'
    this.logger.error(
      'iLink paused this account session (-14): another poller may be running, or the login is stale; retrying after the pause window',
      { retryInMs: this.config.sessionPauseMs },
    )
    // The pause outlives the lock's stale window (120 s), so a silent hour-long
    // sleep would let a second Host take the lock over — and both would then
    // poll when this one resumes. Sleep in slices and keep the heartbeat warm.
    const deadline = Date.now() + this.config.sessionPauseMs
    while (this.status === 'paused' && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      try {
        await sleep(Math.min(this.pauseHeartbeatMs, remaining), this.abort.signal)
      } catch {
        return
      }
      if (this.status !== 'paused') return
      await this.lock?.touch()
    }
    if (this.status === 'paused') {
      this.status = 'running'
      this.logger.info('resuming polling after the session pause')
    }
  }

  /**
   * Validate and route one raw inbound message.
   *
   * @param {any} raw - one element of `getupdates.msgs`.
   * @returns {Promise<void>} resolves once routed or ignored.
   */
  async #accept(raw) {
    const message = normalizeInbound(raw)
    if (message === null) return

    const userId = message.fromUserId
    if (this.state.isDuplicate(userId, message.messageId)) {
      this.logger.debug('duplicate message ignored', { userId, messageId: message.messageId })
      return
    }
    if (isGroupMessage(message)) {
      // Non-goal for the MVP: group traffic is ignored, not answered.
      this.logger.debug('group message ignored', { userId })
      return
    }

    if (message.contextToken !== undefined) {
      await this.state.setContextToken(userId, message.contextToken).catch((error) => {
        this.logger.error('failed to persist a context token', error)
      })
    }

    this.logger.contentDebug('inbound text', { userId, text: message.text })

    const isAllowed = this.allowed.isAllowed(userId)
    const command = parseCommand(message.text)
    if (command !== null) {
      const outcome = await this.commands.handle({ userId, command, isAllowed })
      if (outcome.handled) {
        await this.#sendText(userId, outcome.reply)
        return
      }
      if (!isAllowed) {
        await this.#sendUnpairedHint(userId)
        return
      }
    } else if (!isAllowed) {
      await this.#sendUnpairedHint(userId)
      return
    }

    if (message.text.length === 0) {
      if (message.hasUnsupportedItems) {
        await this.#sendText(userId, 'Only text messages are supported right now.')
      }
      return
    }

    await this.#enqueue(userId, message)
  }

  /**
   * Queue one prompt for a sender.
   *
   * @param {string} userId - sender id.
   * @param {object} message - normalized message.
   * @returns {Promise<void>} resolves once queued.
   */
  async #enqueue(userId, message) {
    const queue = this.queues.get(userId) ?? []
    if (queue.length >= this.config.queueLimit) {
      this.logger.warn('queue limit reached', { userId, queueLimit: this.config.queueLimit })
      await this.#sendText(userId, 'Still working on earlier messages. Please wait before sending more.')
      return
    }
    queue.push(message)
    this.queues.set(userId, queue)
    const draining = this.#drain(userId)
    this.drainPromises.add(draining)
    draining.then(
      () => this.drainPromises.delete(draining),
      (error) => {
        this.drainPromises.delete(draining)
        this.logger.error('sender queue failed', error)
      },
    )
  }

  /**
   * Serially process one sender's queue. One active prompt per chat.
   *
   * @param {string} userId - sender id.
   * @returns {Promise<void>} resolves when the queue drained.
   */
  async #drain(userId) {
    if (this.draining.has(userId)) return
    this.draining.add(userId)
    const signal = this.abort.signal
    try {
      while ((this.status === 'running' || this.status === 'paused') && !signal.aborted) {
        if (this.active.has(userId)) break
        const queue = this.queues.get(userId)
        if (queue === undefined || queue.length === 0) break
        const message = queue.shift()
        if (queue.length === 0) this.queues.delete(userId)
        await this.#runTurn(userId, message)
      }
    } finally {
      this.draining.delete(userId)
    }
  }

  /**
   * Run one prompt through the Host and reply with the collected text.
   *
   * @param {string} userId - sender id.
   * @param {object} message - normalized message.
   * @returns {Promise<void>} resolves after the reply attempt.
   */
  async #runTurn(userId, message) {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, controller.signal])
    const active = { controller, phase: 'preparing', requestId: randomUUID(), startedAt: Date.now() }
    this.active.set(userId, active)
    const onAbort = () => {
      if (active.phase === 'admitting') active.cancelDuringAdmission = true
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let turn
    let admission
    try {
      const mapping = await this.router.sessionFor(userId)
      active.sessionId = mapping.sessionId
      if (signal.aborted) return
      turn = this.collector.begin({ sessionId: active.sessionId, requestId: active.requestId, signal })
      turn.promise.catch(() => {})
      await Promise.race([this.#typing(userId, true, signal), turn.promise])
      if (signal.aborted) return

      active.phase = 'admitting'
      admission = this.host.prompt({
        sessionId: active.sessionId,
        requestId: active.requestId,
        text: message.text,
        signal,
      }).then((result) => {
        active.phase = 'running'
        return result
      })
      await Promise.race([admission, turn.promise.then(() => undefined)])
      const result = await turn.promise
      await this.#replyToTurn(userId, result)
    } catch (error) {
      turn?.cancel('prompt-failed')
      await this.#handleTurnError(userId, error)
    } finally {
      if (signal.aborted && this.status === 'error' && active.phase === 'running' && !active.cancelDuringAdmission) {
        try {
          this.host.cancel({ sessionId: active.sessionId })
        } catch (error) {
          active.keepActive = true
          this.logger.error('could not cancel a turn after ownership loss', error)
        }
      }
      if (admission && (active.phase === 'admitting' || active.cancelDuringAdmission)) {
        // Session-wide cancellation must finish before another prompt is admitted.
        await admission.then(() => {
          if (!signal.aborted) return
          try {
            this.host.cancel({ sessionId: active.sessionId })
          } catch (error) {
            active.keepActive = true
            this.logger.error('could not cancel a late prompt admission', error)
          }
        }, () => {})
      }
      signal.removeEventListener('abort', onAbort)
      if (!active.keepActive) this.active.delete(userId)
      this.suppressAbort.delete(userId)
      await this.#typing(userId, false, signal)
    }
  }

  /**
   * Translate one settled turn into a WeChat reply.
   *
   * @param {string} userId - sender id.
   * @param {object} result - collector result.
   * @returns {Promise<void>} resolves after sending.
   */
  async #replyToTurn(userId, result) {
    const text = joinSteps(result.steps, this.config.replyMode)

    switch (result.reason) {
      case 'completed':
        if (text.length > 0) await this.#sendText(userId, text)
        else await this.#sendText(userId, 'Done — the agent finished without text output.')
        return
      case 'aborted':
        if (this.suppressAbort.delete(userId)) return
        await this.#sendText(userId, text.length > 0 ? `${text}\n\n(turn stopped)` : 'Turn stopped.')
        return
      case 'max-tokens':
        await this.#sendText(
          userId,
          text.length > 0 ? `${text}\n\n(response hit the output limit)` : 'The response hit the output limit.',
        )
        return
      case 'error': {
        const reason = result.reasonDetail?.error?.message ?? 'unknown error'
        await this.#sendText(
          userId,
          `${text.length > 0 ? `${text}\n\n` : ''}The agent turn failed: ${shorten(reason)}`,
        )
        return
      }
      case 'blocked':
        await this.#sendText(userId, 'The turn was blocked before producing a reply.')
        return
      case 'interrupted':
        await this.#sendText(
          userId,
          'The turn was interrupted (for example by a Host restart). Send the message again or /new.',
        )
        return
      case 'forked':
        await this.#sendText(userId, 'The turn was closed by a session fork.')
        return
      default:
        await this.#sendText(userId, `The turn ended (${result.reason}).`)
    }
  }

  /**
   * Turn one prompt/collector failure into an actionable reply.
   *
   * @param {string} userId - sender id.
   * @param {Error & {code?: string}} error - failure.
   * @returns {Promise<void>} resolves after sending.
   */
  async #handleTurnError(userId, error) {
    if (this.abort?.signal.aborted) return
    const code = error?.code

    if (code === 'turn-timeout') {
      const active = this.active.get(userId)
      if (active.phase === 'preparing') {
        active.controller.abort()
        await this.#sendText(userId, 'Timed out preparing the agent request. No prompt was submitted; please retry.')
        return
      }
      try {
        this.host.cancel({ sessionId: active.sessionId })
        active.controller.abort()
      } catch (cancelError) {
        active.keepActive = true
        this.logger.error('could not cancel a timed-out turn', cancelError)
        await this.#sendText(userId, 'Timed out waiting for the agent. Cancellation failed; send /stop to try again.')
        return
      }
      await this.#sendText(userId, 'Timed out waiting for the agent. Cancellation was requested; please retry when it has stopped.')
      return
    }
    if (code === 'session/not-found') {
      await this.#sendText(
        userId,
        'Your DSH session no longer exists. Send /new to start a fresh session; the old history is kept on the Host.',
      )
      return
    }
    if (code === 'session/agent-busy') {
      await this.#sendText(userId, 'The agent is busy with another prompt. Try again in a moment.')
      return
    }
    if (code === 'aborted' || code === 'disposed') return

    this.logger.error('turn failed', error)
    await this.#sendText(userId, `The agent request failed: ${shorten(error.message)}`)
  }

  /**
   * Send long text as chunked WeChat messages.
   *
   * @param {string} userId - recipient.
   * @param {string} text - reply text.
   * @returns {Promise<void>} resolves when the chunks were sent or sending gave up.
   */
  async #sendText(userId, text) {
    if (typeof text !== 'string' || text.length === 0) return
    const chunks = splitText(text, this.config.maxMessageChars)
    if (chunks.length === 0) return

    for (let index = 0; index < chunks.length; index += 1) {
      const sent = await this.#sendChunk(userId, chunks[index])
      if (!sent) return
      if (index < chunks.length - 1) {
        try {
          await sleep(this.config.chunkDelayMs, this.abort?.signal)
        } catch {
          return
        }
      }
    }
  }

  /**
   * Send one chunk, retrying once on a plain network failure.
   *
   * @param {string} userId - recipient.
   * @param {string} chunk - text chunk.
   * @returns {Promise<boolean>} true when the server accepted it.
   */
  async #sendChunk(userId, chunk) {
    // Keep the server's deduplication hint stable if the acknowledgement is lost.
    const clientId = randomUUID()
    const send = () =>
      this.client.sendMessage({
        toUserId: userId,
        text: chunk,
        contextToken: this.state.contextTokenFor(userId),
        clientId,
        signal: this.abort?.signal,
      })

    try {
      await send()
      return true
    } catch (error) {
      if (error.code === 'aborted') return false
      if (error.code === 'network' && error.retryable) {
        this.logger.warn('sendMessage network failure; retrying once', { userId })
        try {
          await send()
          return true
        } catch (retryError) {
          this.logger.error('sendMessage failed after retry', retryError)
          return false
        }
      }
      this.logger.error('sendMessage failed', error)
      return false
    }
  }

  /**
   * Best-effort typing indicator.
   *
   * @param {string} userId - target user.
   * @param {boolean} on - true to start, false to stop.
   * @returns {Promise<void>} resolves even when typing is unavailable.
   */
  async #typing(userId, on, signal = this.abort?.signal) {
    try {
      let cached = this.typingTickets.get(userId)
      if (!on && cached === undefined) return
      if (on && (cached === undefined || Date.now() - cached.at > 10 * 60 * 1000)) {
        const config = await raceAbort(this.client.getConfig({
          userId,
          contextToken: this.state.contextTokenFor(userId),
          signal,
        }), signal)
        if (typeof config.typingTicket !== 'string' || config.typingTicket.length === 0) return
        cached = { ticket: config.typingTicket, at: Date.now() }
        this.typingTickets.set(userId, cached)
      }
      await raceAbort(this.client.sendTyping({
        userId,
        typingTicket: cached.ticket,
        status: on ? TYPING_START : TYPING_STOP,
        signal,
      }), signal)
    } catch (error) {
      if (error.code !== 'aborted') {
        this.logger.debug('typing indicator unavailable', { reason: error.message })
      }
    }
  }

  /**
   * Tell an unpaired sender how to pair, at most once per minute.
   *
   * @param {string} userId - sender id.
   * @returns {Promise<void>} resolves after the hint.
   */
  async #sendUnpairedHint(userId) {
    const now = Date.now()
    const last = this.unpairedHintAt.get(userId) ?? 0
    if (now - last < 60_000) return
    this.unpairedHintAt.set(userId, now)
    await this.#sendText(
      userId,
      'This chat is not paired with the DSH agent. Send /bind <code> with the pairing code from the operator.',
    )
  }

  /**
   * Fire a lifecycle notification without blocking startup or shutdown.
   *
   * @param {'notifyStart'|'notifyStop'} method - client method.
   * @returns {Promise<void>} resolves once attempted.
   */
  async #notifyLifecycle(method) {
    try {
      await this.client?.[method]?.()
    } catch (error) {
      this.logger.warn(`${method} failed`, { reason: error.message })
    }
  }
}
