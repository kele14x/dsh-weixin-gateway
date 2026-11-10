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
import {
  DEFAULT_CDN_BASE,
  TYPING_START,
  TYPING_STOP,
  VERSION,
  botAgentFor,
} from './ilink/constants.mjs'
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MEDIA_TIMEOUT_MS,
  MediaDownloader,
} from './media/download.mjs'
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
   * @param {object} [options.media] - media downloader override for tests.
   * @param {number} [options.lockRetryMs] - delay before retrying a poller lock held elsewhere.
   * @param {number} [options.pauseHeartbeatMs] - lock heartbeat interval during a `-14` pause.
   */
  constructor({
    config,
    host,
    logger = silentLogger,
    accounts,
    clientFactory,
    media,
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
    this.mediaEnabled = config.mediaEnabled !== false
    this.media = media
    if (this.mediaEnabled && this.media === undefined) {
      try {
        this.media = new MediaDownloader({
          cdnBaseUrl: config.cdnBaseUrl ?? DEFAULT_CDN_BASE,
          maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
          timeoutMs: config.mediaTimeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
          logger: this.logger,
        })
      } catch (error) {
        this.mediaEnabled = false
        this.logger.error('inbound image support is disabled', { reason: error.message })
      }
    }
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
    this.disposeApproval = undefined
    /** @type {Map<string, object>} live permission requests; never persisted or replayed */
    this.approvals = new Map()
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
          approval: (userId, response) => this.respondApproval(userId, response),
        },
        allowed: this.allowed,
        config: this.config,
        logger: this.logger,
      })

      this.disposeApproval = this.host.onApproval((request) => this.#requestApproval(request))

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
      this.disposeApproval?.()
      this.disposeApproval = undefined
      this.collector?.dispose()
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
    this.disposeApproval?.()
    this.disposeApproval = undefined
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
    const approvals = [...this.approvals.values()].filter((entry) => entry.userId === userId)
    for (const entry of approvals) {
      lines.push(`permission: /allow ${entry.id} or /deny ${entry.id}`)
    }
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
    active.approvalsClosed = true
    this.#clearApprovals(userId, active)
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
    this.#clearApprovals(userId)
    return `Started a new DSH session: ${created.sessionId}\nThe previous session and its history are kept.`
  }

  /**
   * Claim a live approval only for our admitted turn. Returning undefined lets
   * other Host answerers handle desktop or unrelated Sessions.
   *
   * @param {object} request - normalized approval/request from the Host.
   * @returns {Promise<string>|string|undefined} one-shot outcome, or delegation.
   */
  #requestApproval(request) {
    const owner = [...this.active.entries()].find(([, active]) => active.sessionId === request.sessionId)
    if (owner === undefined) return undefined
    const [userId, active] = owner
    if (!this.collector.isActiveTurn(active)) return undefined
    if (!this.#canApprove(userId, active)) return 'unavailable'
    if (typeof request.toolName !== 'string' || request.toolName.trim().length === 0) return 'unavailable'
    return this.#presentApproval(userId, active, request)
  }

  async #presentApproval(userId, active, request) {
    const delivery = new AbortController()
    const signal = AbortSignal.any([
      this.abort.signal, active.controller.signal, delivery.signal,
      ...(request.signal ? [request.signal] : []),
    ])
    if (signal.aborted) return 'cancelled'

    let id
    try {
      id = await raceAbort(this.state.nextApprovalId(userId), signal)
    } catch {
      if (signal.aborted) return 'cancelled'
      this.logger.error('could not persist a permission request counter')
      return 'unavailable'
    }
    if (signal.aborted || !this.#canApprove(userId, active)) return 'cancelled'
    const key = `${userId}:${id}`
    let resolve
    const promise = new Promise((settle) => { resolve = settle })
    const entry = { id, userId, active, signal, delivered: false }
    const onAbort = () => entry.finish('cancelled')
    entry.finish = (outcome) => {
      if (this.approvals.get(key) !== entry) return false
      this.approvals.delete(key)
      signal.removeEventListener('abort', onAbort)
      delivery.abort()
      resolve(outcome)
      return true
    }
    this.approvals.set(key, entry)
    signal.addEventListener('abort', onAbort, { once: true })

    // The reason is user-facing context, not tool arguments or hidden reasoning.
    // Bound it to keep permission prompts short; never send it to the logger.
    const reason = request.displayReason?.en ?? request.reason
    const text = [
      'Permission required:',
      `Tool: ${shorten(request.toolName, 100)}`,
      ...(typeof reason === 'string' && reason.trim() ? [`Reason: ${shorten(reason, 600)}`] : []),
      '',
      `/allow ${id} — allow this action once`,
      `/deny ${id} — reject this action`,
      'No reply grants no permission. /stop cancels the turn.',
    ].join('\n')
    // Do not block the inbound message queue while waiting for a decision.
    this.#sendText(userId, text, { signal }).then((sent) => {
      if (sent) entry.delivered = true
      else entry.finish('unavailable')
    }, () => entry.finish('unavailable'))
    return promise
  }

  /** @returns {boolean} whether the chat still owns a live, answerable turn. */
  #canApprove(userId, active) {
    return (this.status === 'running' || this.status === 'paused') &&
      !this.abort.signal.aborted && !active.controller.signal.aborted && active.approvalsClosed !== true &&
      this.allowed.isAllowed(userId) && this.active.get(userId) === active &&
      this.state.sessionFor(userId)?.sessionId === active.sessionId &&
      this.collector.isActiveTurn(active)
  }

  /**
   * Consume an explicit, sender-bound decision outside the normal prompt queue.
   *
   * @param {string} userId - paired WeChat sender.
   * @param {{id: string, outcome: string}} response - one request's answer.
   * @returns {string} acknowledgement (not a claim that the tool succeeded).
   */
  respondApproval(userId, { id, outcome }) {
    const entry = this.approvals.get(`${userId}:${id}`)
    if (entry === undefined || entry.userId !== userId) return 'That permission request is no longer pending for this chat.'
    if (entry.signal.aborted || !this.#canApprove(userId, entry.active)) {
      entry.finish('cancelled')
      return 'That permission request is no longer pending for this chat.'
    }
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return 'Invalid permission response.'
    if (outcome === 'allowed-once' && !entry.delivered) {
      return `The permission prompt is still being delivered. Retry /allow ${id} after it arrives.`
    }
    entry.finish(outcome)
    return outcome === 'allowed-once' ? 'Approval sent (allow once).' : 'Permission denied.'
  }

  /** Withdraw requests when their turn or chat mapping is no longer usable. */
  #clearApprovals(userId, active) {
    for (const entry of this.approvals.values()) {
      if (entry.userId === userId && (active === undefined || entry.active === active)) entry.finish('cancelled')
    }
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

    const notices = []
    if (message.unsupportedItemCount > 0) {
      notices.push(
        'Only text and image messages are supported right now; other attachments were skipped.',
      )
    }
    const imagesEnabled = this.mediaEnabled && this.media !== undefined
    if (message.images.length > 0 && !imagesEnabled) {
      notices.push('Image messages are not enabled on this gateway.')
    }
    const maxImages = this.config.maxImagesPerMessage ?? 9
    if (imagesEnabled && message.images.length > maxImages) {
      await this.#sendText(userId, `Too many images in one message (limit ${maxImages}).`)
      return
    }
    if (notices.length > 0) await this.#sendText(userId, notices.join('\n'))

    if (message.text.length === 0 && (message.images.length === 0 || !imagesEnabled)) return

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

      // Start the typing indicator while the image download runs. `#typing`
      // never rejects; the collector starts once the prompt content is ready.
      const typing = this.#typing(userId, true, signal)
      const images = await this.#loadImages(message, signal)
      if (signal.aborted) return

      turn = this.collector.begin({ sessionId: active.sessionId, requestId: active.requestId, signal })
      turn.promise.catch(() => {})
      await Promise.race([typing, turn.promise])
      if (signal.aborted) return

      active.phase = 'admitting'
      admission = this.host.prompt({
        sessionId: active.sessionId,
        requestId: active.requestId,
        content: this.#promptContent(message.text, images),
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
      this.#clearApprovals(userId, active)
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
   * Download every image attached to one normalized message.
   *
   * Images are fetched only after the sender passed the allowlist and only for
   * the duration of the turn, so `/stop` cancels an in-flight download.
   *
   * @param {object} message - normalized inbound message.
   * @param {AbortSignal} signal - turn lifetime.
   * @returns {Promise<Array<{data: Buffer, mediaType: string}>>} decrypted images.
   */
  async #loadImages(message, signal) {
    if (!this.mediaEnabled || this.media === undefined || message.images.length === 0) return []
    const images = []
    for (const item of message.images) {
      images.push(await this.media.downloadImage(item, { signal }))
    }
    return images
  }

  /**
   * Build the ordered DSH prompt content for text and images.
   *
   * @param {string} text - message caption or prompt text.
   * @param {Array<{data: Buffer, mediaType: string}>} images - downloaded images.
   * @returns {object[]} DSH content parts.
   */
  #promptContent(text, images) {
    const content = []
    if (typeof text === 'string' && text.length > 0) {
      content.push({ type: 'text', text })
    }
    for (const image of images) {
      content.push({
        type: 'image',
        data: image.data.toString('base64'),
        mediaType: image.mediaType,
      })
    }
    return content
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

    if (code === 'aborted' || code === 'disposed' || code === 'media/aborted') return

    if (code === 'media/too-large') {
      const limit = this.config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
      const megabytes = Math.max(1, Math.round(limit / (1024 * 1024)))
      await this.#sendText(userId, `That image is too large to process (limit ${megabytes} MB).`)
      return
    }
    if (code === 'media/unsupported-type') {
      await this.#sendText(
        userId,
        'That image format is not supported. Send a PNG, JPEG, WebP, or GIF image.',
      )
      return
    }
    if (
      code === 'media/no-url' ||
      code === 'media/empty' ||
      code === 'media/http' ||
      code === 'media/network' ||
      code === 'media/timeout' ||
      code === 'media/blocked-url' ||
      code === 'media/blocked-host'
    ) {
      this.logger.warn('inbound image download failed', {
        code,
        ...(error.status === undefined ? {} : { status: error.status }),
      })
      await this.#sendText(userId, 'Could not download the image. Please send it again.')
      return
    }
    if (code === 'media/decrypt' || code === 'media/invalid-key') {
      this.logger.warn('inbound image decryption failed', { code })
      await this.#sendText(userId, 'The image could not be decrypted. Please send it again.')
      return
    }
    if (code === 'session/attachment-invalid') {
      const reason = error.details?.reason ?? error.reason
      if (
        reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES' ||
        /does not support image input/i.test(error.message ?? '')
      ) {
        await this.#sendText(
          userId,
          'The selected model does not accept image input. Switch to an image-capable model (for example deepseek-flash) or send text only.',
        )
        return
      }
      await this.#sendText(userId, `The attachment was rejected: ${shorten(error.message)}`)
      return
    }

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

    this.logger.error('turn failed', error)
    await this.#sendText(userId, `The agent request failed: ${shorten(error.message)}`)
  }

  /**
   * Send long text as chunked WeChat messages.
   *
   * @param {string} userId - recipient.
   * @param {string} text - reply text.
   * @param {object} [options] - delivery lifetime.
   * @param {AbortSignal} [options.signal] - withdraw an obsolete permission prompt.
   * @returns {Promise<boolean>} true only when every chunk was accepted.
   */
  async #sendText(userId, text, { signal = this.abort?.signal } = {}) {
    if (typeof text !== 'string' || text.length === 0) return false
    const chunks = splitText(text, this.config.maxMessageChars)
    if (chunks.length === 0) return false

    for (let index = 0; index < chunks.length; index += 1) {
      if (signal?.aborted) return false
      const sent = await this.#sendChunk(userId, chunks[index], signal)
      if (!sent) return false
      if (index < chunks.length - 1) {
        try {
          await sleep(this.config.chunkDelayMs, signal)
        } catch {
          return false
        }
      }
    }
    return true
  }

  /**
   * Send one chunk, retrying once on a plain network failure.
   *
   * @param {string} userId - recipient.
   * @param {string} chunk - text chunk.
   * @param {AbortSignal} [signal] - delivery lifetime.
   * @returns {Promise<boolean>} true when the server accepted it.
   */
  async #sendChunk(userId, chunk, signal = this.abort?.signal) {
    // Keep the server's deduplication hint stable if the acknowledgement is lost.
    const clientId = randomUUID()
    const send = () =>
      this.client.sendMessage({
        toUserId: userId,
        text: chunk,
        contextToken: this.state.contextTokenFor(userId),
        clientId,
        signal,
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
