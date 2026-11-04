/**
 * Unicode-safe text chunking for WeChat's per-message text budget.
 *
 * Chunking works on code points, never on UTF-16 code units, so emoji and other
 * astral characters are never split into lone surrogates. When a chunk boundary
 * lands inside prose the split moves back to the nearest newline or space.
 *
 * @module dsh-weixin-gateway/util/chunk
 */

import { MAX_TEXT_CHARS } from '../ilink/constants.mjs'

/**
 * Split one message into chunks of at most `limit` code points.
 *
 * @param {string} text - text to split.
 * @param {number} [limit] - maximum code points per chunk.
 * @returns {string[]} one or more non-empty chunks; `[]` for blank input.
 * @throws {TypeError} when `text` is not a string.
 */
export function splitText(text, limit = MAX_TEXT_CHARS) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')

  const points = Array.from(text)
  if (points.length === 0) return []

  const chunks = []
  let start = 0
  while (start < points.length) {
    let end = Math.min(start + limit, points.length)
    if (end < points.length) {
      // Prefer a natural break in the last 40% of the window; never cut before
      // 60% or a short chunk would cascade.
      const floor = start + Math.max(1, Math.floor(limit * 0.6))
      let cut = -1
      for (let index = end; index > floor; index -= 1) {
        const char = points[index - 1]
        if (char === '\n' || char === ' ' || char === '\t' || char === '\u3000') {
          cut = index
          break
        }
      }
      if (cut > start) end = cut
    }
    chunks.push(points.slice(start, end).join(''))
    start = end
  }

  const trimmed = chunks.map((chunk) => chunk.replace(/^\s+|\s+$/g, '')).filter((chunk) => chunk.length > 0)
  return trimmed
}
