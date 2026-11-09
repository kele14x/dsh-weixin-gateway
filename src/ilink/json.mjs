/**
 * JSON parsing that preserves iLink's uint64 message identifiers.
 *
 * iLink returns `message_id`, `msg_id`, and `svr_id` as JSON numbers, but they
 * are uint64 values. A plain `JSON.parse` rounds anything above
 * `Number.MAX_SAFE_INTEGER`, which can make two distinct messages share one
 * dedupe key. The scanner below quotes only those numeric fields before parsing,
 * leaving ordinary numbers (`ret`, `seq`, timeouts) untouched.
 *
 * Adapted from Tencent's MIT-licensed `openclaw-weixin` client.
 *
 * @module dsh-weixin-gateway/ilink/json
 */

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id'])

/**
 * Parse JSON while preserving uint64 identifier fields as strings.
 *
 * @param {string} text - raw JSON document.
 * @returns {any} parsed value.
 * @throws {SyntaxError} when the document is not valid JSON.
 */
export function parseJsonPreservingIds(text) {
  let output = ''
  let index = 0

  while (index < text.length) {
    if (text[index] !== '"') {
      output += text[index]
      index += 1
      continue
    }

    const stringStart = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const character = text[index]
      index += 1
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        break
      }
    }
    const stringToken = text.slice(stringStart, index)
    output += stringToken

    let cursor = index
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
    if (text[cursor] !== ':') continue

    let key
    try {
      key = JSON.parse(stringToken)
    } catch {
      continue
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue

    output += text.slice(index, cursor + 1)
    cursor += 1
    while (/\s/.test(text[cursor] ?? '')) {
      output += text[cursor]
      cursor += 1
    }

    const numberStart = cursor
    if (text[cursor] === '-') cursor += 1
    while (/\d/.test(text[cursor] ?? '')) cursor += 1
    const validInteger = cursor > numberStart && !(cursor === numberStart + 1 && text[numberStart] === '-')
    const next = text[cursor]
    if (validInteger && next !== '.' && next !== 'e' && next !== 'E') {
      output += `"${text.slice(numberStart, cursor)}"`
      index = cursor
    } else {
      index = numberStart
    }
  }

  return JSON.parse(output)
}
