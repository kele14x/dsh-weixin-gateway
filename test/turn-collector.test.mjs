import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnCollector, joinSteps, visibleText } from '../src/bridge/turn-collector.mjs'
import { FakeHost } from './helpers/fake-host.mjs'

/**
 * Emit the opening events of one prompt.
 *
 * @param {FakeHost} host - fake host.
 * @param {string} sessionId - session id.
 * @param {string} requestId - request id.
 * @param {number} turn - turn number.
 * @returns {void}
 */
function openTurn(host, sessionId, requestId, turn) {
  host.emit(sessionId, { type: 'turn/start', data: { turn } })
  host.emit(sessionId, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'hi' }] },
  })
}

/**
 * Emit one assistant step.
 *
 * @param {FakeHost} host - fake host.
 * @param {string} sessionId - session id.
 * @param {number} turn - turn number.
 * @param {number} step - step number.
 * @param {object[]} content - content blocks.
 * @returns {void}
 */
function assistantStep(host, sessionId, turn, step, content) {
  host.emit(sessionId, {
    type: 'assistant/message',
    data: { turn, step, message: { content } },
  })
}

test('collects every assistant step of the correlated turn', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  openTurn(host, 's1', 'r1', 4)
  assistantStep(host, 's1', 4, 1, [
    { type: 'text', text: 'first' },
    { type: 'reasoning', text: 'not visible' },
  ])
  assistantStep(host, 's1', 4, 2, [{ type: 'text', text: 'second' }])
  host.emit('s1', { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })

  const result = await handle.promise
  assert.deepEqual(result.steps, ['first', 'second'])
  assert.equal(result.reason, 'completed')
  assert.equal(joinSteps(result.steps), 'first\n\nsecond')
  collector.dispose()
})

test('ignores assistant output from another session and another turn', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  openTurn(host, 's1', 'r1', 2)

  host.emit('s2', { type: 'turn/start', data: { turn: 9 } })
  assistantStep(host, 's2', 9, 1, [{ type: 'text', text: 'other session' }])
  assistantStep(host, 's1', 1, 1, [{ type: 'text', text: 'older turn' }])
  assistantStep(host, 's1', 2, 1, [{ type: 'text', text: 'ours' }])
  host.emit('s1', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

  const result = await handle.promise
  assert.deepEqual(result.steps, ['ours'])
  collector.dispose()
})

test('reports the concrete end reason', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  openTurn(host, 's1', 'r1', 1)
  host.emit('s1', {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } },
  })

  const result = await handle.promise
  assert.equal(result.reason, 'error')
  assert.equal(result.reasonDetail.error.message, 'boom')
  collector.dispose()
})

test('marks a turn that was cancelled mid-stream', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  openTurn(host, 's1', 'r1', 1)
  assistantStep(host, 's1', 1, 1, [{ type: 'text', text: 'partial' }])
  host.emit('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })

  const result = await handle.promise
  assert.equal(result.reason, 'aborted')
  assert.deepEqual(result.steps, ['partial'])
  collector.dispose()
})

test('times out a turn that never ends', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 20 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1', timeoutMs: 20 })
  await assert.rejects(() => handle.promise, (error) => error.code === 'turn-timeout')
  collector.dispose()
})

test('dispose fails every in-flight prompt', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  collector.dispose()
  await assert.rejects(() => handle.promise, (error) => error.code === 'disposed')
})

test('visibleText keeps only text blocks', () => {
  assert.equal(
    visibleText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'tool-call', name: 'x' },
        { type: 'text', text: 'b' },
      ],
    }),
    'ab',
  )
})

test('joinSteps honours reply mode', () => {
  assert.equal(joinSteps(['a', 'b'], 'all'), 'a\n\nb')
  assert.equal(joinSteps(['a', 'b'], 'last'), 'b')
  assert.equal(joinSteps(['', '  '], 'all'), '')
})

test('adopts the next turn when the opening turn/start was missed', async () => {
  const host = new FakeHost()
  const collector = new TurnCollector({ timeoutMs: 2000 })
  collector.attach(host)

  const handle = collector.begin({ sessionId: 's1', requestId: 'r1' })
  host.emit('s1', {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'r1' }, content: [] },
  })
  assistantStep(host, 's1', 3, 1, [{ type: 'text', text: 'late reply' }])
  host.emit('s1', { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })

  const result = await handle.promise
  assert.deepEqual(result.steps, ['late reply'])
  collector.dispose()
})
