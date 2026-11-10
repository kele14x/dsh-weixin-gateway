import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkspaceBinder } from '../src/bridge/workspace.mjs'
import { sessionMappings } from '../src/store/state.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * Workspace registry stand-in that records creation and attachment calls.
 *
 * @param {object} [options] - fake options.
 * @param {boolean} [options.failCreate] - make `create` reject.
 * @param {string[]} [options.reject] - session ids the fake Workspace refuses.
 * @param {string[]} [options.grouped] - session ids the fake Workspace already records.
 * @returns {object} fake registry with a `created`, `attached` and `logs` record.
 */
function fakeRegistry({ failCreate = false, reject = [], grouped = [] } = {}) {
  const record = { created: [], attached: [], logs: [] }
  const workspace = {
    id: 'ws-1',
    path: '/tmp/wechat-canonical',
    title: 'WeChat',
    sessionIds: [...grouped],
    async attachSession(sessionId) {
      if (reject.includes(sessionId)) throw new Error(`cannot attach '${sessionId}'`)
      record.attached.push(sessionId)
      workspace.sessionIds.push(sessionId)
    },
  }
  const registry = {
    async create(dir, title) {
      record.created.push({ dir, title })
      if (failCreate) throw new Error('storage unavailable')
      return workspace
    },
    get(id) {
      return id === workspace.id ? workspace : undefined
    },
  }
  return { registry, workspace, record }
}

/**
 * Write one account state file.
 *
 * @param {string} dir - channel state root.
 * @param {string} name - file stem.
 * @param {object} sessions - `userId -> mapping` table.
 * @returns {Promise<void>} resolves once written.
 */
async function writeState(dir, name, sessions) {
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(
    join(dir, 'state', `${name}.json`),
    JSON.stringify({ version: 1, botId: name, sessions }),
    'utf8',
  )
}

/**
 * Build a binder over a temp state directory.
 *
 * @param {object} t - test context.
 * @param {object} [options] - binder overrides.
 * @returns {Promise<{binder: WorkspaceBinder, stateDir: string}>} binder and its state root.
 */
async function makeBinder(t, options = {}) {
  const stateDir = await makeTempDir('binder')
  t.after(() => cleanup(stateDir))
  const binder = new WorkspaceBinder({
    stateDir,
    dir: '/tmp/wechat',
    title: 'WeChat',
    registryWaitMs: 0,
    logger: silent,
    ...options,
  })
  return { binder, stateDir }
}

test('a binder without a registry groups nothing and never fails', async (t) => {
  const { binder } = await makeBinder(t)
  assert.equal(await binder.ensure(), undefined)
  await binder.adopt()
})

test('ensure creates the workspace once and reuses the binding', async (t) => {
  const { binder } = await makeBinder(t)
  const { registry, record } = fakeRegistry()
  binder.use(registry)

  const first = await binder.ensure()
  const second = await binder.ensure()
  assert.deepEqual(first, { workspaceId: 'ws-1', path: '/tmp/wechat-canonical', title: 'WeChat' })
  assert.deepEqual(second, first)
  assert.deepEqual(record.created, [{ dir: '/tmp/wechat', title: 'WeChat' }])
})

test('a failed registration is reported and retried on the next attempt', async (t) => {
  const stateDir = await makeTempDir('binder-retry')
  t.after(() => cleanup(stateDir))
  const logs = []
  const binder = new WorkspaceBinder({
    stateDir,
    dir: '/tmp/wechat',
    title: 'WeChat',
    registryWaitMs: 0,
    logger: { debug() {}, info() {}, warn: (...args) => logs.push(args), error() {} },
  })
  const { registry } = fakeRegistry({ failCreate: true })
  binder.use(registry)

  assert.equal(await binder.ensure(), undefined)
  assert.equal(await binder.ensure(), undefined)
  assert.equal(logs.length, 2)
  assert.match(logs[0][0], /could not register the WeChat workspace/)
})

test('adopt creates no empty group when the channel has no recorded Session', async (t) => {
  const { binder } = await makeBinder(t)
  const { registry, record } = fakeRegistry()
  binder.use(registry)

  await binder.adopt()
  assert.deepEqual(record.created, [])
})

test('adopt registers the group and attaches Sessions recorded by every account', async (t) => {
  const { binder, stateDir } = await makeBinder(t)
  await writeState(stateDir, 'bot-a', {
    'user-1': { sessionId: 'session-1', cwd: '/tmp/wechat' },
    'user-2': { sessionId: 'session-2', cwd: '/tmp/wechat' },
  })
  await writeState(stateDir, 'bot-b', {
    'user-3': { sessionId: 'session-3', cwd: '/tmp/wechat' },
    'user-4': { sessionId: 'session-old', cwd: '/tmp/elsewhere' },
  })
  const { registry, record } = fakeRegistry({ reject: ['session-old'] })
  binder.use(registry)

  const adopted = await binder.adopt()
  assert.equal(adopted, undefined)
  assert.deepEqual(record.created, [{ dir: '/tmp/wechat', title: 'WeChat' }])
  assert.deepEqual(record.attached, ['session-1', 'session-2', 'session-3'])
})

test('a malformed account state file is skipped instead of failing adoption', async (t) => {
  const { binder, stateDir } = await makeBinder(t)
  await mkdir(join(stateDir, 'state'), { recursive: true })
  await writeFile(join(stateDir, 'state', 'broken.json'), '{not json', 'utf8')
  await writeState(stateDir, 'bot-a', { 'user-1': { sessionId: 'session-1' } })
  const { registry, record } = fakeRegistry()
  binder.use(registry)

  await binder.adopt()
  assert.deepEqual(record.attached, ['session-1'])
})

test('detach drops the registry so a later ensure stops grouping', async (t) => {
  const { binder } = await makeBinder(t)
  binder.use(fakeRegistry().registry)
  assert.notEqual(await binder.ensure(), undefined)

  binder.detach()
  assert.equal(await binder.ensure(), undefined)
})

test('sessionMappings reads every account file and ignores unusable entries', async (t) => {
  const stateDir = await makeTempDir('mappings')
  t.after(() => cleanup(stateDir))
  await writeState(stateDir, 'bot-a', {
    'user-1': { sessionId: 'session-1', cwd: '/tmp/wechat' },
    'user-2': { sessionId: '' },
    'user-3': { sessionId: 42 },
  })
  await writeState(stateDir, 'bot-b', { 'user-4': { sessionId: 'session-4' } })

  const mappings = await sessionMappings(stateDir)
  assert.deepEqual(mappings, [
    { botId: 'bot-a', userId: 'user-1', sessionId: 'session-1', cwd: '/tmp/wechat' },
    { botId: 'bot-b', userId: 'user-4', sessionId: 'session-4' },
  ])
})

test('sessionMappings returns an empty list for a missing state directory', async (t) => {
  const stateDir = await makeTempDir('mappings-empty')
  t.after(() => cleanup(stateDir))
  assert.deepEqual(await sessionMappings(stateDir), [])
})

test('ensure waits briefly for a registry that is injected after the first message', async (t) => {
  const { binder } = await makeBinder(t, { registryWaitMs: 500 })
  const { registry } = fakeRegistry()
  const waiting = binder.ensure()
  setTimeout(() => binder.use(registry), 20)

  assert.deepEqual(await waiting, { workspaceId: 'ws-1', path: '/tmp/wechat-canonical', title: 'WeChat' })
})

test('ensure stops waiting for a registry the profile never composes', async (t) => {
  const { binder } = await makeBinder(t, { registryWaitMs: 20 })
  const started = Date.now()
  assert.equal(await binder.ensure(), undefined)
  assert.ok(Date.now() - started >= 15)
  // The bounded wait happens once, not on every later Session.
  const secondStarted = Date.now()
  assert.equal(await binder.ensure(), undefined)
  assert.ok(Date.now() - secondStarted < 15)
})

test('adopt leaves Sessions that already belong to the group untouched', async (t) => {
  const { binder, stateDir } = await makeBinder(t)
  await writeState(stateDir, 'bot-a', {
    'user-1': { sessionId: 'session-1' },
    'user-2': { sessionId: 'session-2' },
  })
  const { registry, record } = fakeRegistry({ grouped: ['session-1'] })
  binder.use(registry)

  await binder.adopt()
  assert.deepEqual(record.attached, ['session-2'])
})

test('a renamed workspace keeps its title: the binder trusts the registry record', async (t) => {
  const { binder } = await makeBinder(t)
  const { registry, workspace, record } = fakeRegistry()
  workspace.title = '工作微信'
  binder.use(registry)

  const binding = await binder.ensure()
  assert.equal(binding.title, '工作微信')
  // The configured title is only a creation-time suggestion; renaming wins.
  assert.deepEqual(record.created, [{ dir: '/tmp/wechat', title: 'WeChat' }])
})

test('a rename survives a plugin restart: a fresh binder reuses the existing record', async (t) => {
  const stateDir = await makeTempDir('binder-restart')
  t.after(() => cleanup(stateDir))
  const { registry, workspace, record } = fakeRegistry()
  workspace.title = '工作微信'

  // First Host run creates the group; the operator then renames it in the UI,
  // which only mutates the registry record, as the fake already reflects.
  const first = new WorkspaceBinder({ stateDir, dir: '/tmp/wechat', title: 'WeChat', registryWaitMs: 0, logger: silent })
  first.use(registry)
  await first.ensure()

  // Second Host run: a new binder over the same durable registry record.
  const second = new WorkspaceBinder({ stateDir, dir: '/tmp/wechat', title: 'WeChat', registryWaitMs: 0, logger: silent })
  second.use(registry)
  const binding = await second.ensure()

  assert.equal(binding.title, '工作微信')
  assert.equal(binding.workspaceId, 'ws-1')
  assert.deepEqual(record.created.map((entry) => entry.title), ['WeChat', 'WeChat'])
})
