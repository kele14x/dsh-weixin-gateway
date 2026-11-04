import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { raceAbort, sleep } from '../src/util/time.mjs'

for (const preAborted of [false, true]) {
  test(`raceAbort observes a losing rejection with ${preAborted ? 'pre-aborted' : 'later-aborted'} signal`, async () => {
    const controller = new AbortController()
    const pending = Promise.withResolvers()
    if (preAborted) controller.abort()
    const waiting = raceAbort(pending.promise, controller.signal)
    controller.abort()
    await assert.rejects(waiting, { code: 'aborted' })
    pending.reject(new Error('late transport failure'))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

test('raceAbort returns the original value or rejection and removes listeners', async () => {
  const controller = new AbortController()
  assert.equal(await raceAbort(Promise.resolve(42), controller.signal), 42)
  const error = new Error('transport failed')
  await assert.rejects(raceAbort(Promise.reject(error), controller.signal), (actual) => actual === error)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort()
})

test('sleep rejects immediately when already aborted', async () => {
  await assert.rejects(sleep(1000, AbortSignal.abort()), { code: 'aborted' })
})
