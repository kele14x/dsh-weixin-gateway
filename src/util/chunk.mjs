/**
 * Unicode-safe text chunking for WeChat's per-message text budget.
 *
 * Chunking works on code points, never on UTF-16 code units, so emoji and other
 * astral characters are never split into lone surrogates. When a chunk boundary
 * lands inside prose the split moves back to the nearest newline, or failing
 * that the nearest space. Only whitespace at a split is dropped, so a chunk that
 * starts a new line keeps its indentation.
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

  if (text.trim().length === 0) return []

  const points = Array.from(text)
  const chunks = []
  let start = skipBlankLines(points, 0)
  while (start < points.length) {
    let end = Math.min(start + limit, points.length)
    if (end < points.length) {
      // Prefer a natural break in the last 40% of the window; never cut before
      // 60% or a short chunk would cascade.
      const floor = start + Math.max(1, Math.floor(limit * 0.6))
      const newline = lastBreak(points, floor, end, (char) => char === '\n')
      const cut = newline === -1 ? lastBreak(points, floor, end, isHorizontalSpace) : newline
      if (cut !== -1) end = cut
    }
    const chunk = points.slice(start, end).join('').trimEnd()
    if (chunk.length > 0) chunks.push(chunk)
    const atLineStart = points[end - 1] === '\n' || points[end] === '\n' || points[end] === '\r'
    start = atLineStart ? skipBlankLines(points, end) : skipHorizontalSpace(points, end)
  }
  return chunks
}

/**
 * @param {string} char - one code point.
 * @returns {boolean} true for spaces and tabs, but not line breaks.
 */
function isHorizontalSpace(char) {
  return char === ' ' || char === '\t' || char === '\u3000'
}

/**
 * Find the last split point in `(floor, end]` whose preceding code point matches.
 *
 * @param {string[]} points - code points.
 * @param {number} floor - exclusive lower bound.
 * @param {number} end - inclusive upper bound.
 * @param {(char: string) => boolean} match - break predicate.
 * @returns {number} split index, or -1 when none matches.
 */
function lastBreak(points, floor, end, match) {
  for (let index = end; index > floor; index -= 1) {
    if (match(points[index - 1])) return index
  }
  return -1
}

/**
 * Skip whole blank lines, stopping at the start of the next non-blank line.
 *
 * @param {string[]} points - code points.
 * @param {number} index - start index.
 * @returns {number} start of the next non-blank line, or `points.length`.
 */
function skipBlankLines(points, index) {
  let lineStart = index
  for (let cursor = index; cursor < points.length; cursor += 1) {
    const char = points[cursor]
    if (char === '\n') lineStart = cursor + 1
    else if (char !== '\r' && !isHorizontalSpace(char)) return lineStart
  }
  return points.length
}

/**
 * @param {string[]} points - code points.
 * @param {number} index - start index.
 * @returns {number} index of the next code point that is not a space or tab.
 */
function skipHorizontalSpace(points, index) {
  while (index < points.length && isHorizontalSpace(points[index])) index += 1
  return index
}
