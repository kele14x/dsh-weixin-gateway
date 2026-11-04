/**
 * Fake Host bridge for tests.
 *
 * Emits the exact `session/event` payload shapes the real Host produces, so the
 * turn collector is exercised against the integration contract rather than an
 * invented one.
 *
 * @module test/helpers/fake-host
 */

/**
 * In-memory Session Controller stand-in.
 */
export class FakeHost {
  /**
   * @param {object} [options] - fake options.
   * @param {string} [options.prefix] - session id prefix.
   * @param {boolean} [options.autoRespond] - emit a full turn when prompted.
   * @param {(text: string) => string} [options.reply] - reply text builder.
   */
  constructor({ prefix = 'sess', autoRespond = true, reply = (text) => `echo:${text}` } = {}) {
    this.prefix = prefix
    this.autoRespond = autoRespond
    this.reply = reply
    this.calls = []
    this.listeners = new Set()
    this.turn = 1
    this.created = 0
  }

  /**
   * Create a session id.
   *
   * @param {{cwd: string, agentPreset?: string}} options - creation options.
   * @returns {Promise<string>} session id.
   */
  async createSession({ cwd, agentPreset }) {
    this.created += 1
    const sessionId = `${this.prefix}-${this.created}`
    this.calls.push({ type: 'create', sessionId, cwd, agentPreset })
    return sessionId
  }

  /**
   * Admit a prompt and, unless disabled, emit one complete turn.
   *
   * @param {{sessionId: string, requestId: string, text: string}} options - prompt.
   * @returns {Promise<void>} resolves immediately.
   */
  async prompt({ sessionId, requestId, text }) {
    this.calls.push({ type: 'prompt', sessionId, requestId, text })
    if (!this.autoRespond) return
    this.emitTurn({ sessionId, requestId, text })
  }

  /**
   * Emit one completed turn for a prompt.
   *
   * @param {{sessionId: string, requestId: string, text: string, reason?: string}} options - turn.
   * @returns {number} the turn number used.
   */
  emitTurn({ sessionId, requestId, text, reason = 'completed' }) {
    const turn = this.turn
    this.turn += 1
    this.emit(sessionId, { type: 'turn/start', data: { turn } })
    this.emit(sessionId, {
      type: 'user/message',
      data: { id: 'msg', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } },
    })
    const reply = this.reply(text)
    if (reply.length > 0) {
      this.emit(sessionId, {
        type: 'assistant/message',
        data: {
          turn,
          step: 1,
          message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model' } },
        },
      })
    }
    this.emit(sessionId, { type: 'turn/end', data: { turn, reason: { kind: reason } } })
    return turn
  }

  /**
   * Request cancellation.
   *
   * @param {{sessionId: string}} options - cancellation.
   * @returns {void}
   */
  cancel({ sessionId }) {
    this.calls.push({ type: 'cancel', sessionId })
  }

  /**
   * Subscribe, mirroring the real global observer.
   *
   * @param {(payload: {sessionId: string, event: object}) => void} handler - sink.
   * @returns {() => void} disposer.
   */
  observe(handler) {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  /**
   * Emit one event to every observer.
   *
   * @param {string} sessionId - session id.
   * @param {object} event - event record.
   * @returns {void}
   */
  emit(sessionId, event) {
    for (const listener of this.listeners) listener({ sessionId, event })
  }

  /**
   * Calls of one kind.
   *
   * @param {string} type - call type.
   * @returns {object[]} matching calls.
   */
  callsOf(type) {
    return this.calls.filter((call) => call.type === type)
  }
}
