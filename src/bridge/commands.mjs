/**
 * Chat commands.
 *
 * Commands are handled before the agent sees the text. `/bind` is the only
 * command available to an unpaired sender, and it is rate limited so the pairing
 * code cannot be brute-forced from WeChat.
 *
 * @module dsh-weixin-gateway/bridge/commands
 */

import { timingSafeEqual } from 'node:crypto'
import { silentLogger } from '../util/log.mjs'

const COMMAND_PATTERN = /^[a-z][a-z0-9-]*$/
const MAX_BIND_FAILURES = 5
const BIND_FAILURE_WINDOW_MS = 60 * 60 * 1000

/**
 * Compare two secrets without leaking length or content through timing.
 *
 * @param {string} candidate - attacker-supplied value.
 * @param {string} expected - configured secret.
 * @returns {boolean} true when equal.
 */
export function safeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Parse a leading slash command.
 *
 * @param {string} text - inbound message text.
 * @returns {{name: string, args: string[], raw: string}|null} parsed command, or null for ordinary text.
 */
export function parseCommand(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...args] = trimmed.split(/\s+/)
  const name = head.slice(1).toLowerCase()
  if (!COMMAND_PATTERN.test(name)) return null
  return { name, args, raw: trimmed }
}

/** Human-facing help text. */
export const HELP_TEXT = [
  'DSH WeChat gateway commands:',
  '/help — show this message',
  '/new — start a fresh DSH session (old history is kept)',
  '/stop — cancel the running turn and clear the queue',
  '/status — account, session, and queue status',
  '/version — plugin version',
  '/bind <code> — pair this chat (first use only)',
  '',
  'Anything else is sent to the agent as a prompt.',
].join('\n')

/** Routes chat commands to runtime actions. */
export class CommandRouter {
  /**
   * @param {object} options - router options.
   * @param {object} options.actions - runtime callbacks.
   * @param {(userId: string) => Promise<string>|string} options.actions.status - `/status` text.
   * @param {(userId: string) => Promise<string>|string} options.actions.stop - `/stop` text.
   * @param {(userId: string) => Promise<string>|string} options.actions.newSession - `/new` text.
   * @param {() => string} options.actions.version - `/version` text.
   * @param {import('../store/allowed.mjs').AllowList} options.allowed - allowlist.
   * @param {object} options.config - resolved plugin config.
   * @param {object} [options.logger] - logger.
   */
  constructor({ actions, allowed, config, logger = silentLogger }) {
    this.actions = actions
    this.allowed = allowed
    this.config = config
    this.logger = logger
    /** @type {Map<string, {count: number, since: number}>} failed binding attempts */
    this.bindFailures = new Map()
  }

  /**
   * Handle one command message.
   *
   * @param {object} options - command context.
   * @param {string} options.userId - sender id.
   * @param {{name: string, args: string[]}} options.command - parsed command.
   * @param {boolean} options.isAllowed - whether the sender is paired.
   * @returns {Promise<{handled: boolean, reply?: string}>} outcome.
   */
  async handle({ userId, command, isAllowed }) {
    if (command.name === 'bind') {
      return { handled: true, reply: await this.#bind(userId, command.args) }
    }

    if (!isAllowed) {
      return {
        handled: true,
        reply:
          'This chat is not paired with the DSH agent yet. Send /bind <code> with the pairing code from the operator.',
      }
    }

    switch (command.name) {
      case 'help':
        return { handled: true, reply: HELP_TEXT }
      case 'version':
        return { handled: true, reply: this.actions.version() }
      case 'status':
        return { handled: true, reply: await this.actions.status(userId) }
      case 'new':
        return { handled: true, reply: await this.actions.newSession(userId) }
      case 'stop':
        return { handled: true, reply: await this.actions.stop(userId) }
      default:
        // Unknown slash commands are ordinary text and go to the agent.
        return { handled: false }
    }
  }

  /**
   * Validate the pairing code and add the sender.
   *
   * @param {string} userId - sender id.
   * @param {string[]} args - command arguments.
   * @returns {Promise<string>} reply text.
   */
  async #bind(userId, args) {
    if (this.allowed.isAllowed(userId)) return 'This chat is already paired.'

    const envName = this.config.bindCodeEnv
    const expected = envName ? process.env[envName] : undefined
    if (typeof expected !== 'string' || expected.length === 0) {
      return `Pairing is disabled: the operator has not set ${envName || 'the pairing code environment variable'}.`
    }

    if (this.#tooManyFailures(userId)) {
      return 'Too many pairing attempts. Ask the operator for a new code and try again later.'
    }

    const candidate = args[0]
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return 'Usage: /bind <code>'
    }

    if (!safeEqual(candidate, expected)) {
      this.#recordFailure(userId)
      this.logger.warn('rejected pairing attempt', { userId })
      return 'That pairing code is not valid.'
    }

    await this.allowed.allow(userId)
    this.bindFailures.delete(userId)
    this.logger.info('paired a WeChat sender', { userId })
    return 'Paired. Send a message to talk to the agent, or /help for commands.'
  }

  /**
   * @param {string} userId - sender id.
   * @returns {boolean} true when the sender exhausted its attempts.
   */
  #tooManyFailures(userId) {
    const record = this.bindFailures.get(userId)
    if (record === undefined) return false
    if (Date.now() - record.since > BIND_FAILURE_WINDOW_MS) {
      this.bindFailures.delete(userId)
      return false
    }
    return record.count >= MAX_BIND_FAILURES
  }

  /**
   * @param {string} userId - sender id.
   * @returns {void}
   */
  #recordFailure(userId) {
    const now = Date.now()
    const record = this.bindFailures.get(userId)
    if (record === undefined || now - record.since > BIND_FAILURE_WINDOW_MS) {
      this.bindFailures.set(userId, { count: 1, since: now })
      return
    }
    record.count += 1
  }
}
