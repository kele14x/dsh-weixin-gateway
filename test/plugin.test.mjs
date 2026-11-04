import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply, name } from '../src/index.mjs'
import { cleanup, makeTempDir } from './helpers/tmp.mjs'

/**
 * Build a Cordis context stub that records injection and effect calls.
 *
 * @returns {{ctx: object, record: object}} stub and its record.
 */
function fakeCtx() {
  const record = { injected: undefined, effectRuns: 0, disposers: [] }
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
