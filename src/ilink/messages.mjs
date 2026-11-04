/**
 * Inbound/outbound message shapes.
 *
 * The MVP is text-only and direct-messages-only. Normalization drops bot echoes
 * (our own `sendmessage` can come back through the poll), keeps the context
 * token needed for replies, and reports media-only messages so the runtime can
 * answer with a notice instead of silence.
 *
 * @module dsh-weixin-gateway/ilink/messages
 */

import { ITEM_TYPE_TEXT, MESSAGE_TYPE_BOT } from './constants.mjs'

/**
 * Concatenate the text items of one message.
 *
 * @param {unknown} items - `item_list` from a WeixinMessage.
 * @returns {string} joined text, possibly empty.
 */
export function extractText(items) {
  if (!Array.isArray(items)) return ''
  const parts = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (item.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === 'string') {
      parts.push(item.text_item.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Normalize one raw inbound message.
 *
 * @param {any} raw - one element of `getupdates.msgs`.
 * @returns {{messageId: string|number, fromUserId: string, toUserId?: string, contextToken?: string, createTimeMs?: number, groupId?: string, text: string, hasUnsupportedItems: boolean}|null} normalized message, or null to ignore.
 */
export function normalizeInbound(raw) {
  if (raw === null || typeof raw !== 'object') return null
  // Never respond to our own outbound messages.
  if (raw.message_type === MESSAGE_TYPE_BOT) return null

  const fromUserId = raw.from_user_id
  if (typeof fromUserId !== 'string' || fromUserId.length === 0) return null

  const messageId = raw.message_id ?? raw.client_id ?? raw.seq
  if (messageId === undefined || messageId === null) return null

  const items = Array.isArray(raw.item_list) ? raw.item_list : []
  const text = extractText(items)

  return {
    messageId,
    fromUserId,
    ...(typeof raw.to_user_id === 'string' ? { toUserId: raw.to_user_id } : {}),
    ...(typeof raw.context_token === 'string' && raw.context_token.length > 0
      ? { contextToken: raw.context_token }
      : {}),
    ...(typeof raw.create_time_ms === 'number' ? { createTimeMs: raw.create_time_ms } : {}),
    ...(typeof raw.group_id === 'string' && raw.group_id.length > 0 ? { groupId: raw.group_id } : {}),
    text,
    hasUnsupportedItems: text.length === 0 && items.length > 0,
  }
}

/**
 * Whether a normalized message came from a group chat.
 *
 * @param {{groupId?: string}} message - normalized message.
 * @returns {boolean} true for group traffic.
 */
export function isGroupMessage(message) {
  return typeof message?.groupId === 'string' && message.groupId.length > 0
}

/**
 * Stable dedupe identity for a raw message.
 *
 * @param {any} raw - one raw message.
 * @returns {string|number|undefined} server id when present.
 */
export function rawMessageId(raw) {
  return raw?.message_id ?? raw?.client_id ?? raw?.seq
}
