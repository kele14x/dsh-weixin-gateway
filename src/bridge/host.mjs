/**
 * Host bridge.
 *
 * The WeChat transport must not know which DSH profile it runs in, so all
 * Session Controller calls and the global `session/event` subscription live
 * behind this interface. A headless AgentHost implementation can be added later
 * without touching the runtime.
 *
 * @module dsh-weixin-gateway/bridge/host
 */

import { silentLogger } from '../util/log.mjs'

/** Raised when the Host cannot satisfy a bridge operation. */
export class HostError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - human-facing reason.
   * @param {object} [cause] - underlying error.
   */
  constructor(code, message, cause) {
    super(message)
    this.name = 'HostError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Session Controller backed host. This is the preferred integration: it creates
 * preset-aware Sessions, respects workspace and model settings, and maps `/stop`
 * onto the same cancellation path the Web UI uses.
 */
export class SessionControllerHost {
  /**
   * @param {object} ctx - Cordis context that has `sessionController`.
   * @param {object} [options] - bridge options.
   * @param {object} [options.logger] - logger.
   */
  constructor(ctx, { logger = silentLogger } = {}) {
    this.ctx = ctx
    this.logger = logger
  }

  /**
   * Create one Session and return its durable id.
   *
   * @param {object} options - creation options.
   * @param {string} options.cwd - working directory the Session owns.
   * @param {string} [options.agentPreset] - preset the Session runs.
   * @returns {Promise<string>} created Session id.
   */
  async createSession({ cwd, agentPreset }) {
    let value
    try {
      value = await this.ctx.sessionController.create({
        cwd,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
    } catch (error) {
      throw new HostError('create-failed', `could not create a DSH session: ${error.message}`, error)
    }
    const sessionId = value?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HostError('create-failed', 'the Session Controller returned no session id')
    }
    return sessionId
  }

  /**
   * Admit one text prompt into a Session's queue.
   *
   * @param {object} options - prompt options.
   * @param {string} options.sessionId - target Session.
   * @param {string} options.requestId - stable client-minted identity.
   * @param {string} options.text - prompt text.
   * @param {AbortSignal} options.signal - caller lifetime.
   * @returns {Promise<void>} resolves once the Agent accepted the prompt.
   */
  async prompt({ sessionId, requestId, text, signal }) {
    await this.ctx.sessionController.prompt(
      {
        sessionId,
        requestId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      signal,
    )
  }

  /**
   * Request cancellation of the active turn.
   *
   * @param {object} options - cancellation options.
   * @param {string} options.sessionId - target Session.
   * @returns {void}
   */
  cancel({ sessionId }) {
    this.ctx.sessionController.cancel({ sessionId })
  }

  /**
   * Observe Session events across every Session on the Host.
   *
   * The `global` option is required: without it the listener only sees Sessions
   * in this plugin's scope, which is none of them.
   *
   * @param {(payload: {sessionId: string, event: object}) => void} handler - event sink.
   * @returns {() => void} disposer.
   */
  observe(handler) {
    return this.ctx.on(
      'session/event',
      (session, event) => {
        try {
          handler({ sessionId: String(session.id), event })
        } catch (error) {
          this.logger.error('session event handler failed', { reason: error.message })
        }
      },
      { global: true },
    )
  }
}

/**
 * Build the bridge for the composed profile.
 *
 * Only the Session Controller path is implemented in this first cut; a profile
 * without it fails loudly instead of silently falling back to a different
 * session model.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [options] - bridge options.
 * @param {object} [options.logger] - logger.
 * @returns {SessionControllerHost} host bridge.
 * @throws {HostError} when `sessionController` is not composed.
 */
export function createHost(ctx, { logger = silentLogger } = {}) {
  if (ctx?.sessionController === undefined) {
    throw new HostError(
      'missing-session-controller',
      'the sessionController service is not composed in this profile; install the channel in the `web` profile (or add dsh-api-session-controller)',
    )
  }
  return new SessionControllerHost(ctx, { logger })
}
