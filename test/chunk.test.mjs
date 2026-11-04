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
