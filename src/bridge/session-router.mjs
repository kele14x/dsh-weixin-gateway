/**
 * WeChat sender to DSH Session routing.
 *
 * One sender owns exactly one long-lived Session. The mapping is persisted, so a
 * gateway restart resumes the same Session instead of starting a new one, and
 * `/new` replaces the mapping while leaving the old Session history intact.
 *
 * @module dsh-weixin-gateway/bridge/session-router
 */

import { silentLogger } from '../util/log.mjs'

/** Creates and remembers one DSH Session per WeChat sender. */
export class SessionRouter {
  /**
   * @param {object} options - router options.
   * @param {{createSession: Function}} options.host - host bridge.
   * @param {import('../store/state.mjs').ChannelState} options.state - durable state.
   * @param {string} options.defaultCwd - working directory for new Sessions.
   * @param {string} [options.agentPreset] - preset for new Sessions.
   * @param {object} [options.logger] - logger.
   */
  constructor({ host, state, defaultCwd, agentPreset, logger = silentLogger }) {
    this.host = host
    this.state = state
    this.defaultCwd = defaultCwd
    this.agentPreset = agentPreset
    this.logger = logger
    /** @type {Map<string, Promise<object>>} in-flight creations per sender */
    this.inflight = new Map()
  }

  /**
   * Existing mapping, or a freshly created Session.
   *
   * @param {string} userId - WeChat sender id.
   * @returns {Promise<{sessionId: string, cwd: string, created: boolean}>} resolved mapping.
   */
  async sessionFor(userId) {
    const existing = this.state.sessionFor(userId)
    if (existing !== undefined) {
      await this.state.touchSession(userId)
      return { sessionId: existing.sessionId, cwd: existing.cwd, created: false }
    }

    const running = this.inflight.get(userId)
    if (running !== undefined) return running

    const creation = this.#create(userId).finally(() => this.inflight.delete(userId))
    this.inflight.set(userId, creation)
    return creation
  }

  /**
   * Replace a sender's mapping with a new Session.
   *
   * @param {string} userId - WeChat sender id.
   * @returns {Promise<{sessionId: string, cwd: string, created: true}>} new mapping.
   */
  async reset(userId) {
    const previous = this.state.sessionFor(userId)
    const created = await this.#create(userId)
    this.logger.info('replaced session mapping', {
      userId,
      previousSessionId: previous?.sessionId,
      sessionId: created.sessionId,
    })
    return created
  }

  /**
   * Create one Session and persist its mapping.
   *
   * @param {string} userId - WeChat sender id.
   * @returns {Promise<{sessionId: string, cwd: string, created: true}>} new mapping.
   */
  async #create(userId) {
    const sessionId = await this.host.createSession({
      cwd: this.defaultCwd,
      ...(this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset }),
    })
    await this.state.setSession(userId, { sessionId, cwd: this.defaultCwd })
    this.logger.info('created session', { userId, sessionId })
    return { sessionId, cwd: this.defaultCwd, created: true }
  }
}
