import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Config, apply, name } from '../src/index.mjs'
import { cleanup, makeTempDir, waitFor } from './helpers/tmp.mjs'

/**
 * Build a Cordis context stub that records injection and effect calls.
 *
 * `workspaceRegistry` stands in for the optional service: when omitted the
 * nested `inject` callback never runs, exactly as an unavailable service
 * behaves in the Host.
 *
 * @param {object} [options] - stub options.
 * @param {object} [options.workspaceRegistry] - registry to expose, if any.
 * @returns {{ctx: object, record: object}} stub and its record.
 */
function fakeCtx({ workspaceRegistry } = {}) {
  const record = {
    injected: undefined,
    effectRuns: 0,
    disposers: [],
    workspaceInjected: undefined,
    workspaceEffectRuns: 0,
    workspaceDisposers: [],
  }
  const registryChild = {
    workspaceRegistry,
    effect: (execute) => {
      record.workspaceEffectRuns += 1
      record.workspaceDisposers.push(execute())
      return () => {}
    },
  }
  const child = {
    sessionController: {
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: async () => {},
      cancel: () => {},
    },
    on: () => () => {},
    effect: (execute) => {
      record.effectRuns += 1
      record.disposers.push(execute())
      return () => {}
    },
    inject: (deps, callback) => {
      record.workspaceInjected = deps
      if (workspaceRegistry !== undefined) callback(registryChild)
    },
  }
  const ctx = {
    inject: (deps, callback) => {
      record.injected = deps
      callback(child)
    },
  }
  return { ctx, record }
}

test('the plugin export is named and has a config schema', () => {
  assert.equal(name, 'dsh-weixin-gateway')
  const resolved = Config({ stateDir: '/tmp/state', defaultCwd: '/tmp' })
  assert.equal(resolved.maxMessageChars, 1800)
  assert.equal(resolved.replyMode, 'all')
  assert.equal(resolved.bindCodeEnv, 'DSH_WEIXIN_BIND_CODE')
  assert.equal(resolved.mediaEnabled, true)
  assert.equal(resolved.cdnBaseUrl, 'https://novac2c.cdn.weixin.qq.com/c2c')
  assert.equal(resolved.maxImageBytes, 20 * 1024 * 1024)
  assert.equal(resolved.maxImagesPerMessage, 9)
  assert.equal(resolved.mediaTimeoutMs, 60_000)
})

test('the config schema rejects a zero image byte cap', () => {
  assert.throws(() => Config({ stateDir: '/tmp/state', maxImageBytes: 0 }))
  assert.equal(Config({ stateDir: '/tmp/state', maxImageBytes: 1 }).maxImageBytes, 1)
})

test('the config schema rejects a zero chunk size', () => {
  assert.throws(() => Config({ stateDir: '/tmp/state', maxMessageChars: 0 }))
  assert.equal(Config({ stateDir: '/tmp/state', maxMessageChars: 1 }).maxMessageChars, 1)
})

test('a relative stateDir disables the channel instead of mounting', () => {
  const { ctx, record } = fakeCtx()
  apply(ctx, { stateDir: 'relative/state', defaultCwd: process.cwd(), logLevel: 'silent' })
  assert.equal(record.injected, undefined)
  assert.equal(record.effectRuns, 0)
})

test('a missing defaultCwd disables the channel instead of mounting', () => {
  const { ctx, record } = fakeCtx()
  apply(ctx, { stateDir: '/tmp/state', defaultCwd: '/definitely/not/here', logLevel: 'silent' })
  assert.equal(record.injected, undefined)
  assert.equal(record.effectRuns, 0)
})

test('a valid config injects sessionController and mounts a disposable effect', async (t) => {
  const dir = await makeTempDir('plugin')
  t.after(() => cleanup(dir))

  const { ctx, record } = fakeCtx()
  apply(ctx, { stateDir: dir, defaultCwd: process.cwd(), logLevel: 'silent' })

  assert.deepEqual(record.injected, ['sessionController'])
  assert.equal(record.effectRuns, 1)
  assert.equal(typeof record.disposers[0], 'function')

  await record.disposers[0]()
})

test('an empty defaultCwd falls back to the plugin workspace directory', async (t) => {
  const dir = await makeTempDir('plugin')
  t.after(() => cleanup(dir))

  const { ctx, record } = fakeCtx()
  apply(ctx, { stateDir: dir, defaultCwd: '', logLevel: 'silent' })

  const { existsSync } = await import('node:fs')
  const { defaultWorkspace } = await import('../src/index.mjs')
  assert.equal(existsSync(defaultWorkspace()), true)
  assert.deepEqual(record.injected, ['sessionController'])
  await record.disposers[0]()
})

test('the config schema groups WeChat sessions under one workspace by default', () => {
  assert.equal(Config({ stateDir: '/tmp/state' }).workspaceTitle, 'WeChat')
  assert.equal(Config({ stateDir: '/tmp/state', workspaceTitle: '' }).workspaceTitle, '')
})

test('an explicit workspaceTitle overrides the default and adopts earlier Sessions', async (t) => {
  const dir = await makeTempDir('plugin-workspace')
  t.after(() => cleanup(dir))
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(
    join(dir, 'state', 'bot-a.json'),
    JSON.stringify({ version: 1, botId: 'bot-a', sessions: { u1: { sessionId: 'session-1', cwd: dir } } }),
    'utf8',
  )

  const created = []
  const attached = []
  const workspace = {
    id: 'ws-1',
    path: dir,
    title: '微信',
    sessionIds: [],
    attachSession: async (sessionId) => attached.push(sessionId),
  }
  const registry = {
    async create(path, title) {
      created.push({ path, title })
      return workspace
    },
    get: (id) => (id === workspace.id ? workspace : undefined),
  }

  const { ctx, record } = fakeCtx({ workspaceRegistry: registry })
  apply(ctx, { stateDir: dir, defaultCwd: dir, workspaceTitle: '微信', logLevel: 'silent' })

  assert.deepEqual(record.injected, ['sessionController'])
  assert.deepEqual(record.workspaceInjected, ['workspaceRegistry'])
  assert.equal(record.workspaceEffectRuns, 1)
  await waitFor(() => attached.length === 1, { message: 'adopted WeChat session' })
  assert.deepEqual(created, [{ path: dir, title: '微信' }])
  assert.deepEqual(attached, ['session-1'])

  await record.disposers[0]()
  await record.workspaceDisposers[0]()
})

test('an empty title leaves the channel ungrouped and never asks for the registry', async (t) => {
  const dir = await makeTempDir('plugin-ungrouped')
  t.after(() => cleanup(dir))

  const { ctx, record } = fakeCtx({ workspaceRegistry: { create: async () => assert.fail('must not group') } })
  apply(ctx, { stateDir: dir, defaultCwd: dir, workspaceTitle: '', logLevel: 'silent' })

  assert.equal(record.workspaceInjected, undefined)
  assert.equal(record.workspaceEffectRuns, 0)
  await record.disposers[0]()
})

test('a fresh install groups under the default WeChat title', async (t) => {
  const dir = await makeTempDir('plugin-default-title')
  t.after(() => cleanup(dir))
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(
    join(dir, 'state', 'bot-a.json'),
    JSON.stringify({ version: 1, botId: 'bot-a', sessions: { u1: { sessionId: 'session-1' } } }),
    'utf8',
  )

  const titles = []
  const workspace = {
    id: 'ws-1',
    path: dir,
    title: 'WeChat',
    sessionIds: [],
    attachSession: async () => {},
  }
  const registry = {
    async create(_path, title) {
      titles.push(title)
      return workspace
    },
    get: () => workspace,
  }

  const { ctx, record } = fakeCtx({ workspaceRegistry: registry })
  apply(ctx, { stateDir: dir, defaultCwd: dir, logLevel: 'silent' })

  await waitFor(() => titles.length === 1, { message: 'default workspace registration' })
  assert.deepEqual(titles, ['WeChat'])

  await record.disposers[0]()
  await record.workspaceDisposers[0]()
})
