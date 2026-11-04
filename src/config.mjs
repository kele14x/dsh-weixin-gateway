/**
 * Plugin configuration schema.
 *
 * The schema is exported as `Config` so the Loader validates the row and the
 * settings surface can render defaults. Values supplied by the bundle patch
 * (`stateDir`, `defaultCwd`) stay required: a silent fallback would put WeChat
 * state in an unexpected directory.
 *
 * @module dsh-weixin-gateway/config
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BASE_URL,
  DEFAULT_POLL_TIMEOUT_MS,
  MAX_TEXT_CHARS,
  SESSION_PAUSED_MS,
} from './ilink/constants.mjs'

/** Configuration accepted by the WeChat channel plugin. */
export const Config = z.object({
  stateDir: z
    .string()
    .required()
    .description('Directory for credentials, poll cursor, allowlist, and the poller lock.'),
  defaultCwd: z
    .string()
    .required()
    .description('Working directory assigned to DSH sessions created for WeChat senders.'),
  agentPreset: z
    .string()
    .description('Optional DSH agent preset for sessions this channel creates.'),
  baseUrl: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description('iLink API origin. A QR redirect may override it for the saved account.'),
  maxMessageChars: z
    .natural()
    .default(MAX_TEXT_CHARS)
    .description('Maximum code points per outbound WeChat message.'),
  chunkDelayMs: z
    .natural()
    .default(400)
    .description('Delay between consecutive outbound chunks, in milliseconds.'),
  pollTimeoutMs: z
    .natural()
    .default(DEFAULT_POLL_TIMEOUT_MS)
    .description('Long-poll budget; the server-suggested value wins when present.'),
  queueLimit: z
    .natural()
    .default(8)
    .description('Maximum queued inbound messages per WeChat sender.'),
  turnTimeoutMs: z
    .natural()
    .default(600_000)
    .description('How long to wait for one DSH turn before giving up.'),
  bindCodeEnv: z
    .string()
    .default('DSH_WEIXIN_BIND_CODE')
    .description('Environment variable holding the one-time /bind code. Empty disables pairing.'),
  replyMode: z
    .union([z.const('all'), z.const('last')])
    .default('all')
    .description('Send every assistant step of a turn, or only the final one.'),
  sessionPauseMs: z
    .natural()
    .default(SESSION_PAUSED_MS)
    .description('Pause after a -14 account-session response, in milliseconds.'),
  logLevel: z
    .union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error'), z.const('silent')])
    .default('info')
    .description('Plugin log threshold.'),
  debugLogContent: z
    .boolean()
    .default(false)
    .description('Allow raw message text in debug logs. Off by default and never enabled in Docker.'),
  botAgent: z
    .string()
    .description('Observability-only bot_agent token; not authentication.'),
})
