/**
 * Protocol constants and version encoding for the iLink Bot API.
 *
 * The wire values here are pinned from Tencent's MIT-licensed
 * `openclaw-weixin` protocol notes (docs/protocol_zh_CN.md). They are treated as
 * observed client behaviour, not as a stable public contract, so every value
 * lives in this module instead of being inlined at call sites.
 *
 * @module dsh-weixin-gateway/ilink/constants
 */

import { readFileSync } from 'node:fs'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)

/** Package name, used for the bundle row and diagnostics. */
export const PACKAGE_NAME = manifest.name

/** Package version, sent as `channel_version` and encoded in a request header. */
export const VERSION = manifest.version

/** Default API origin. The QR login flow may switch to a server-supplied redirect. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Default media CDN origin (phase 2; unused by the text-only MVP). */
export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** `iLink-App-Id` value: the bot application id. */
export const APP_ID = 'bot'

/** `AuthorizationType` value for bot-token authentication. */
export const AUTH_TYPE = 'ilink_bot_token'

/** Endpoint paths. Note that the notify pair lives under `/msg/`, unlike the rest. */
export const PATHS = Object.freeze({
  botQrcode: '/ilink/bot/get_bot_qrcode',
  qrcodeStatus: '/ilink/bot/get_qrcode_status',
  updates: '/ilink/bot/getupdates',
  sendMessage: '/ilink/bot/sendmessage',
  getConfig: '/ilink/bot/getconfig',
  sendTyping: '/ilink/bot/sendtyping',
  notifyStart: '/ilink/bot/msg/notifystart',
  notifyStop: '/ilink/bot/msg/notifystop',
  uploadUrl: '/ilink/bot/getuploadurl',
})

/** Server-suggested long-poll budget (response field `longpolling_timeout_ms`). */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000

/** A `-14` response pauses the account session for one hour. */
export const SESSION_PAUSED_MS = 60 * 60 * 1000

/** Default outbound text budget, in code points, per WeChat message. */
export const MAX_TEXT_CHARS = 1800

/** `WeixinMessage.message_type`: the message came from a human user. */
export const MESSAGE_TYPE_USER = 1

/** `WeixinMessage.message_type`: the message came from a bot (including us). */
export const MESSAGE_TYPE_BOT = 2

/** `MessageItem.type`: plain text item. */
export const ITEM_TYPE_TEXT = 1

/** `sendTyping.status`: start the typing indicator. */
export const TYPING_START = 1

/** `sendTyping.status`: clear the typing indicator. */
export const TYPING_STOP = 2

/** `sendMessage.msg.message_type`: outbound messages are bot messages. */
export const OUTBOUND_MESSAGE_TYPE = 2

/** `sendMessage.msg.message_state`: a completed, non-streaming message. */
export const MESSAGE_STATE_COMPLETE = 2

/**
 * Encode a semver version the way the iLink client does: `0x00MMNNPP` as a
 * decimal string. Pre-release and build metadata are ignored; each component is
 * clamped to one byte.
 *
 * @param {string} version - package version, e.g. `0.1.0`.
 * @returns {string} decimal string of the packed version.
 */
export function encodeClientVersion(version) {
  const parts = String(version).split('-')[0].split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 255) : 0
  })
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return String(((major << 16) | (minor << 8) | patch) >>> 0)
}

/**
 * `bot_agent` is an observability token only; it never participates in
 * authentication or routing.
 *
 * @param {string} version - package version.
 * @returns {string} UA-style agent token.
 */
export function botAgentFor(version) {
  return `dsh-weixin/${version}`
}

/** Client version header value for this build. */
export const CLIENT_VERSION_HEADER = encodeClientVersion(VERSION)
