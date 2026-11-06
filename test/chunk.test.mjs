import test from 'node:test'
import assert from 'node:assert/strict'
import { splitText } from '../src/util/chunk.mjs'

test('short text stays in one chunk', () => {
  assert.deepEqual(splitText('hello', 100), ['hello'])
})

test('blank text produces no chunks', () => {
  assert.deepEqual(splitText('', 10), [])
  assert.deepEqual(splitText('   \n  ', 10), [])
})

test('no chunk exceeds the code-point limit', () => {
  const text = 'word '.repeat(500)
  const chunks = splitText(text, 100)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 100, chunk)
})

test('never splits a surrogate pair', () => {
  const text = '😀'.repeat(50)
  const chunks = splitText(text, 7)
  assert.equal(chunks.join(''), text)
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 7)
})

test('prefers a whitespace boundary when one is available', () => {
  const chunks = splitText('aaa bbb ccc', 8)
  assert.deepEqual(chunks, ['aaa bbb', 'ccc'])
})

test('rejects invalid input', () => {
  assert.throws(() => splitText(42), TypeError)
  assert.throws(() => splitText('x', 0), RangeError)
})

test('keeps the indentation of a line that starts a new chunk', () => {
  const text = '#' + 'x'.repeat(1788) + '\ndef f():\n    return 42'
  const chunks = splitText(text, 1800)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], '#' + 'x'.repeat(1788) + '\ndef f():')
  assert.equal(chunks[1], '    return 42')
})

test('keeps leading indentation and inner blank lines within a chunk', () => {
  assert.deepEqual(splitText('\n\n    indented\n\n  next\n\n', 100), ['    indented\n\n  next'])
})

test('drops blank lines and continuation spaces at a split', () => {
  assert.deepEqual(splitText('aaaa bbbb\n\n\n    cccc', 12), ['aaaa bbbb', '    cccc'])
  assert.deepEqual(splitText('aaaa bbbb   cccc', 10), ['aaaa bbbb', 'cccc'])
})
