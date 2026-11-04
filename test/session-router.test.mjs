import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionRouter } from '../src/bridge/session-router.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function makeRouter(t, { count = 3, agentPreset } = {}) {
  const stateDir = await makeTempDir('session-router')
  t.after(() => cleanup(stateDir))
  const state = new ChannelState({ stateDir, botId: 'bot1' })
  await state.load()
  const attempts = Array.from({ length: count }, () => ({ started: deferred(), result: deferred() }))
  const calls = []
  const host = {
    createSession(options) {
      const attempt = attempts[calls.length]
      assert.ok(attempt, 'unexpected session creation')
      calls.push(options)
      attempt.started.resolve()
      return attempt.result.promise
    },
  }
  const router = new SessionRouter({ host, state, defaultCwd: '/tmp/project', agentPreset })
  return { router, state, stateDir, attempts, calls }
}

async function reopen(stateDir) {
  const state = new ChannelState({ stateDir, botId: 'bot1' })
  await state.load()
  return state
}

test('first prompt and /new serialize creation and keep the acknowledged reset durable', async (t) => {
  const { router, state, stateDir, attempts, calls } = await makeRouter(t)
  const prompt = router.sessionFor('u1')
  const reset = router.reset('u1')
  const queuedPrompt = router.sessionFor('u1')
  assert.equal(router.inflight.has('u1'), true)
  await attempts[0].started.promise
  assert.equal(calls.length, 1)
  assert.equal(state.sessionFor('u1'), undefined)

  attempts[0].result.resolve('initial-session')
  assert.equal((await prompt).sessionId, 'initial-session')
  await attempts[1].started.promise
  assert.equal(calls.length, 2)
  const promptAfterCreation = router.sessionFor('u1')
  attempts[1].result.resolve('new-session')
  for (const result of await Promise.all([reset, queuedPrompt, promptAfterCreation])) {
    assert.deepEqual(result, { sessionId: 'new-session', cwd: '/tmp/project', created: true })
  }
  assert.equal(router.inflight.has('u1'), false)
  assert.equal(state.sessionFor('u1').sessionId, 'new-session')
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'new-session')
  assert.deepEqual(await router.sessionFor('u1'), {
    sessionId: 'new-session', cwd: '/tmp/project', created: false,
  })
  assert.equal(calls.length, 2)
})

test('sessionFor joins a reset registered synchronously instead of returning an existing mapping', async (t) => {
  const { router, state, stateDir, attempts, calls } = await makeRouter(t)
  await state.setSession('u1', { sessionId: 'old-session', cwd: '/tmp/old' })
  const reset = router.reset('u1')
  const immediatePrompt = router.sessionFor('u1')
  await attempts[0].started.promise
  assert.equal(state.sessionFor('u1').sessionId, 'old-session')
  const laterPrompt = router.sessionFor('u1')
  let settled = false
  immediatePrompt.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(calls.length, 1)

  attempts[0].result.resolve('replacement')
  const results = await Promise.all([reset, immediatePrompt, laterPrompt])
  assert.deepEqual(results.map((result) => result.sessionId), Array(3).fill('replacement'))
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'replacement')
})

test('multiple concurrent resets stay ordered and prompts follow the last queued reset', async (t) => {
  const { router, state, stateDir, attempts, calls } = await makeRouter(t)
  await state.setSession('u1', { sessionId: 'original', cwd: '/tmp/project' })
  const first = router.reset('u1')
  const second = router.reset('u1')
  const third = router.reset('u1')
  const earlyPrompt = router.sessionFor('u1')
  await attempts[0].started.promise
  assert.equal(calls.length, 1)

  attempts[0].result.resolve('reset-1')
  assert.equal((await first).sessionId, 'reset-1')
  await attempts[1].started.promise
  assert.equal(calls.length, 2)
  assert.equal(state.sessionFor('u1').sessionId, 'reset-1')
  const middlePrompt = router.sessionFor('u1')

  attempts[1].result.resolve('reset-2')
  assert.equal((await second).sessionId, 'reset-2')
  await attempts[2].started.promise
  assert.equal(calls.length, 3)
  assert.equal(state.sessionFor('u1').sessionId, 'reset-2')
  const latePrompt = router.sessionFor('u1')

  attempts[2].result.resolve('reset-3')
  const results = await Promise.all([third, earlyPrompt, middlePrompt, latePrompt])
  assert.deepEqual(results.map((result) => result.sessionId), Array(4).fill('reset-3'))
  assert.equal(router.inflight.has('u1'), false)
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'reset-3')
})

test('a failed initial creation does not reject or block a queued reset', async (t) => {
  const { router, state, stateDir, attempts, calls } = await makeRouter(t)
  const first = router.sessionFor('u1')
  const failure = assert.rejects(first, /initial creation failed/)
  const reset = router.reset('u1')
  const prompt = router.sessionFor('u1')
  await attempts[0].started.promise
  assert.equal(calls.length, 1)
  attempts[0].result.reject(new Error('initial creation failed'))
  await failure
  await attempts[1].started.promise
  assert.equal(calls.length, 2)
  assert.equal(state.sessionFor('u1'), undefined)
  const laterPrompt = router.sessionFor('u1')

  attempts[1].result.resolve('recovered')
  const results = await Promise.all([reset, prompt, laterPrompt])
  assert.deepEqual(results.map((result) => result.sessionId), Array(3).fill('recovered'))
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'recovered')
  assert.equal((await router.sessionFor('u1')).created, false)
})

test('a failed initial creation clears its slot so a later reset can succeed', async (t) => {
  const { router, stateDir, attempts } = await makeRouter(t)
  const failure = assert.rejects(router.sessionFor('u1'), /creation failed/)
  await attempts[0].started.promise
  attempts[0].result.reject(new Error('creation failed'))
  await failure
  assert.equal(router.inflight.has('u1'), false)

  const reset = router.reset('u1')
  await attempts[1].started.promise
  attempts[1].result.resolve('later-reset')
  assert.equal((await reset).sessionId, 'later-reset')
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'later-reset')
})

test('a failed reset does not block another queued reset or its waiting prompt', async (t) => {
  const { router, state, stateDir, attempts, calls } = await makeRouter(t)
  await state.setSession('u1', { sessionId: 'original', cwd: '/tmp/project' })
  const failure = assert.rejects(router.reset('u1'), /reset failed/)
  const second = router.reset('u1')
  const prompt = router.sessionFor('u1')
  await attempts[0].started.promise
  assert.equal(calls.length, 1)
  attempts[0].result.reject(new Error('reset failed'))
  await failure
  await attempts[1].started.promise
  assert.equal(state.sessionFor('u1').sessionId, 'original')
  attempts[1].result.resolve('successful-reset')
  assert.equal((await second).sessionId, 'successful-reset')
  assert.equal((await prompt).sessionId, 'successful-reset')
  assert.equal((await reopen(stateDir)).sessionFor('u1').sessionId, 'successful-reset')
})

test('session creation is shared per sender without blocking other senders', async (t) => {
  const { router, stateDir, attempts, calls } = await makeRouter(t, { agentPreset: 'coding' })
  const first = router.sessionFor('u1')
  const duplicate = router.sessionFor('u1')
  const other = router.sessionFor('u2')
  await Promise.all([attempts[0].started.promise, attempts[1].started.promise])
  assert.deepEqual(calls, Array(2).fill({ cwd: '/tmp/project', agentPreset: 'coding' }))

  attempts[1].result.resolve('other-session')
  assert.equal((await other).sessionId, 'other-session')
  assert.equal(router.inflight.has('u1'), true)
  attempts[0].result.resolve('first-session')
  assert.deepEqual(await first, await duplicate)
  assert.equal(router.inflight.size, 0)
  const restarted = await reopen(stateDir)
  assert.equal(restarted.sessionFor('u1').sessionId, 'first-session')
  assert.equal(restarted.sessionFor('u2').sessionId, 'other-session')
})
