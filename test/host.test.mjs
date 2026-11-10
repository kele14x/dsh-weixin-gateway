import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionControllerHost } from '../src/bridge/host.mjs'

function fakeHost() {
  const record = { subscriptions: [], logs: [], disposed: 0 }
  const disposer = () => { record.disposed += 1 }
  const ctx = {
    on: (event, listener, options) => {
      record.subscriptions.push({ event, listener, options })
      return disposer
    },
  }
  const host = new SessionControllerHost(ctx, {
    logger: { error: (...args) => record.logs.push(args) },
  })
  return { host, record, disposer }
}

function approvalRequest() {
  return {
    agent: { session: { id: 42 }, secret: 'private-agent-token' },
    toolName: 'shell',
    callId: 'call-1',
    reason: 'private request text',
    displayReason: { en: 'private display reason', zh: 'private translation' },
    signal: new AbortController().signal,
    extra: 'private extra field',
  }
}

function unexpectedNext() {
  assert.fail('a claimed approval must not delegate')
}

test('onApproval subscribes globally before the UI and returns the subscription disposer', () => {
  const { host, record, disposer } = fakeHost()
  const returned = host.onApproval(() => undefined)

  assert.equal(record.subscriptions.length, 1)
  assert.equal(record.subscriptions[0].event, 'approval/request')
  assert.deepEqual(record.subscriptions[0].options, { global: true, prepend: true })
  assert.equal(returned, disposer)
  returned()
  assert.equal(record.disposed, 1)
})

test('onApproval routes synchronously with exactly the normalized payload and no agent reference', async () => {
  const { host, record } = fakeHost()
  const req = approvalRequest()
  let received
  let finish
  const answer = new Promise((resolve) => { finish = resolve })
  host.onApproval((payload) => {
    received = payload
    return answer
  })

  const result = record.subscriptions[0].listener(req, unexpectedNext)
  assert.deepEqual(received, {
    sessionId: '42',
    toolName: req.toolName,
    callId: req.callId,
    reason: req.reason,
    displayReason: req.displayReason,
    signal: req.signal,
  })
  assert.notEqual(received, req)
  assert.equal(Object.hasOwn(received, 'agent'), false)
  assert.equal(received.displayReason, req.displayReason)
  assert.equal(received.signal, req.signal)
  finish('allowed-once')
  assert.equal(await result, 'allowed-once')
})

test('onApproval preserves absent optional fields and accepts a zero session id', async () => {
  const { host, record } = fakeHost()
  let received
  host.onApproval((payload) => {
    received = payload
    return 'cancelled'
  })

  assert.equal(await record.subscriptions[0].listener({
    agent: { session: { id: 0 } }, toolName: 'shell',
  }, unexpectedNext), 'cancelled')
  assert.deepEqual(received, {
    sessionId: '0', toolName: 'shell', callId: undefined,
    reason: undefined, displayReason: undefined, signal: undefined,
  })
})

for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
  for (const asynchronous of [false, true]) {
    test(`onApproval accepts ${asynchronous ? 'async' : 'sync'} ${outcome}`, async () => {
      const { host, record } = fakeHost()
      host.onApproval(() => asynchronous ? Promise.resolve(outcome) : outcome)

      assert.equal(await record.subscriptions[0].listener(approvalRequest(), unexpectedNext), outcome)
      assert.deepEqual(record.logs, [])
    })
  }
}

test('an unowned request delegates exactly once and returns the downstream promise unchanged', async () => {
  const { host, record } = fakeHost()
  let handlerCalls = 0
  let nextCalls = 0
  const downstream = Promise.resolve('allowed-once')
  host.onApproval(() => { handlerCalls += 1 })

  const result = record.subscriptions[0].listener(approvalRequest(), () => {
    nextCalls += 1
    return downstream
  })
  assert.equal(handlerCalls, 1)
  assert.equal(nextCalls, 1)
  assert.equal(result, downstream)
  assert.equal(await result, 'allowed-once')
  assert.deepEqual(record.logs, [])
})

test('missing agent session ids safely delegate without calling the handler', () => {
  const requests = [
    undefined, null, {}, { agent: null }, { agent: {} },
    { agent: { session: null } }, { agent: { session: {} } },
    { agent: { session: { id: null } } }, { agent: { session: { id: '' } } },
  ]
  for (const req of requests) {
    const { host, record } = fakeHost()
    let nextCalls = 0
    host.onApproval(() => assert.fail('missing session id must not reach the handler'))

    const result = record.subscriptions[0].listener(req, () => {
      nextCalls += 1
      return 'rejected'
    })
    assert.equal(result, 'rejected')
    assert.equal(nextCalls, 1)
    assert.deepEqual(record.logs, [])
  }
})

test('delegated synchronous errors are not answered or logged as claimed failures', () => {
  const { host, record } = fakeHost()
  const error = new Error('private downstream error')
  let nextCalls = 0
  host.onApproval(() => undefined)

  assert.throws(() => record.subscriptions[0].listener(approvalRequest(), () => {
    nextCalls += 1
    throw error
  }), (thrown) => thrown === error)
  assert.equal(nextCalls, 1)
  assert.deepEqual(record.logs, [])
})

test('delegated promise rejections remain downstream failures', async () => {
  const { host, record } = fakeHost()
  const error = new Error('private downstream rejection')
  const downstream = Promise.reject(error)
  let nextCalls = 0
  host.onApproval(() => undefined)

  const result = record.subscriptions[0].listener(approvalRequest(), () => {
    nextCalls += 1
    return downstream
  })
  assert.equal(result, downstream)
  await assert.rejects(result, (rejected) => rejected === error)
  assert.equal(nextCalls, 1)
  assert.deepEqual(record.logs, [])
})

for (const asynchronous of [false, true]) {
  test(`claimed ${asynchronous ? 'rejections' : 'throws'} fail closed with only generic logging`, async () => {
    for (const failure of [new Error('private failure secret'), 'private thrown secret', null]) {
      const { host, record } = fakeHost()
      host.onApproval(() => {
        if (asynchronous) return Promise.reject(failure)
        throw failure
      })

      assert.equal(await record.subscriptions[0].listener(approvalRequest(), unexpectedNext), 'unavailable')
      assert.deepEqual(record.logs, [['approval handler failed']])
    }
  })
}

test('invalid claimed outcomes fail closed without delegating or logging their contents', async () => {
  const invalid = [null, false, true, 1, '', 'allowed', 'private invalid secret', {}, ['allowed-once']]
  for (const value of invalid) {
    for (const asynchronous of [false, true]) {
      const { host, record } = fakeHost()
      host.onApproval(() => asynchronous ? Promise.resolve(value) : value)

      assert.equal(await record.subscriptions[0].listener(approvalRequest(), unexpectedNext), 'unavailable')
      assert.deepEqual(record.logs, [])
    }
  }
})

test('a promise resolving undefined is claimed and fails closed rather than delegating', async () => {
  const { host, record } = fakeHost()
  host.onApproval(async () => undefined)

  assert.equal(await record.subscriptions[0].listener(approvalRequest(), unexpectedNext), 'unavailable')
  assert.deepEqual(record.logs, [])
})

/** Session Controller stub that records creation requests. */
function controllerCtx(create, logs = []) {
  return {
    sessionController: { create },
    logger: { error: (...args) => logs.push(args) },
  }
}

test('createSession names the Workspace instead of a cwd when the Session is grouped', async () => {
  const requests = []
  const ctx = controllerCtx(async (request) => {
    requests.push(request)
    return { sessionId: 'sess-1' }
  })
  const host = new SessionControllerHost(ctx)

  assert.equal(await host.createSession({ cwd: '/tmp/project', workspaceId: 'ws-1', agentPreset: 'coding' }), 'sess-1')
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', agentPreset: 'coding' }])
})

test('createSession keeps creating in cwd when no Workspace is named', async () => {
  const requests = []
  const ctx = controllerCtx(async (request) => {
    requests.push(request)
    return { sessionId: 'sess-1' }
  })
  const host = new SessionControllerHost(ctx)

  assert.equal(await host.createSession({ cwd: '/tmp/project' }), 'sess-1')
  assert.deepEqual(requests, [{ cwd: '/tmp/project' }])
})

test('createSession retries in cwd when the Workspace disappeared underneath the channel', async () => {
  const requests = []
  const warnings = []
  const missing = new Error('workspace "ws-1" not found')
  missing.code = 'workspace/not-found'
  const ctx = controllerCtx(
    async (request) => {
      requests.push(request)
      if (requests.length === 1) throw missing
      return { sessionId: 'sess-2' }
    },
    warnings,
  )
  const host = new SessionControllerHost(ctx, { logger: { warn: (...args) => warnings.push(args), error() {} } })

  assert.equal(await host.createSession({ cwd: '/tmp/project', workspaceId: 'ws-1' }), 'sess-2')
  assert.deepEqual(requests, [{ workspaceId: 'ws-1' }, { cwd: '/tmp/project' }])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /creating an ungrouped Session/)
})

test('createSession does not retry unrelated Workspace creation failures', async () => {
  const failure = new Error('model unavailable')
  const ctx = controllerCtx(async () => {
    throw failure
  })
  const host = new SessionControllerHost(ctx, { logger: { warn() {}, error() {} } })

  await assert.rejects(
    () => host.createSession({ cwd: '/tmp/project', workspaceId: 'ws-1' }),
    (error) => error.code === 'create-failed' && error.cause === failure,
  )
})
