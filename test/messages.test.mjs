import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInbound } from '../src/ilink/messages.mjs'

/**
 * Build one raw inbound message.
 *
 * @param {object[]} itemList - message items.
 * @param {object} [overrides] - extra fields.
 * @returns {object} raw message.
 */
function message(itemList, overrides = {}) {
  return {
    message_id: 1,
    from_user_id: 'u1',
    message_type: 1,
    context_token: 'ctx',
    item_list: itemList,
    ...overrides,
  }
}

test('normalizeInbound keeps text and image items together', () => {
  const normalized = normalizeInbound(
    message([
      { type: 1, text_item: { text: 'what is this?' } },
      { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
    ]),
  )
  assert.equal(normalized.text, 'what is this?')
  assert.equal(normalized.images.length, 1)
  assert.equal(normalized.unsupportedItemCount, 0)
  assert.equal(normalized.hasUnsupportedItems, false)
})

test('normalizeInbound reports an image-only message without unsupported items', () => {
  const normalized = normalizeInbound(
    message([{ type: 2, image_item: { media: { encrypt_query_param: 'p' } } }]),
  )
  assert.equal(normalized.text, '')
  assert.equal(normalized.images.length, 1)
  assert.equal(normalized.unsupportedItemCount, 0)
})

test('normalizeInbound counts non-image media as unsupported', () => {
  const normalized = normalizeInbound(
    message([
      { type: 4, file_item: { file_name: 'report.pdf' } },
      { type: 3, voice_item: { media: { encrypt_query_param: 'p' } } },
    ]),
  )
  assert.equal(normalized.images.length, 0)
  assert.equal(normalized.unsupportedItemCount, 2)
  assert.equal(normalized.hasUnsupportedItems, true)
})

test('normalizeInbound ignores bot echoes and malformed senders', () => {
  assert.equal(normalizeInbound(message([], { message_type: 2 })), null)
  assert.equal(normalizeInbound(message([], { from_user_id: '' })), null)
  assert.equal(normalizeInbound(null), null)
})
