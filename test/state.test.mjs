import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChannelState } from '../src/store/state.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

/**
 * @param {object} [options] - state options.
 * @returns {Promise<ChannelState>} loaded state.
 */
async function loadedState(dir, options = {}) {
  const state = new ChannelState({ stateDir: dir, botId: 'bot1', ...options })
  await state.load()
  return state
}

test('cursor persists and an empty cursor is ignored', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setCursor('')
  assert.equal(state.cursor, '')

  await state.setCursor('cursor-1')
  const reopened = await loadedState(dir)
  assert.equal(reopened.cursor, 'cursor-1')
})

for (const field of ['cursor', 'contextToken']) {
  for (const concurrent of [false, true]) {
    test(`${field} same-value ${concurrent ? 'concurrent callers and retries' : 'retry'} persists after a failed write`, async (t) => {
      const dir = await makeTempDir('state-retry')
      t.after(() => cleanup(dir))
      const state = await loadedState(dir)
      const update = () => field === 'cursor'
        ? state.setCursor('cursor-1')
        : state.setContextToken('user-1', 'ctx-1')
      await writeFile(state.dir, 'disposable write obstruction')
      if (concurrent) {
        const results = await Promise.allSettled([update(), update()])
        assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected'])
      } else {
        await assert.rejects(update)
      }
      await rm(state.dir)
      await update()
      const reopened = await loadedState(dir)
      if (field === 'cursor') assert.equal(reopened.cursor, 'cursor-1')
      else assert.equal(reopened.contextTokenFor('user-1'), 'ctx-1')
    })
  }
}

test('session mappings survive a reload', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setSession('user-1', { sessionId: 'session-1', cwd: '/tmp' })

  const reopened = await loadedState(dir)
  const mapping = reopened.sessionFor('user-1')
  assert.equal(mapping?.sessionId, 'session-1')
  assert.equal(mapping?.cwd, '/tmp')
})

test('context tokens are remembered per sender', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setContextToken('user-1', 'ctx-1')
  await state.setContextToken('user-2', 'ctx-2')

  const reopened = await loadedState(dir)
  assert.equal(reopened.contextTokenFor('user-1'), 'ctx-1')
  assert.equal(reopened.contextTokenFor('user-2'), 'ctx-2')
})

test('dedupe detects a repeated message id and keeps ids scoped per sender', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  assert.equal(state.isDuplicate('user-1', 7), false)
  assert.equal(state.isDuplicate('user-1', 7), true)
  assert.equal(state.isDuplicate('user-2', 7), false)
})

test('dedupe window is bounded', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir, { dedupeLimit: 5 })
  for (let index = 0; index < 20; index += 1) state.isDuplicate('user-1', index)
  assert.ok(state.seen.size <= 5)
})

test('state files are written with mode 0600', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))

  const state = await loadedState(dir)
  await state.setCursor('cursor-1')
  const info = await stat(join(dir, 'state', 'bot1.json'))
  assert.equal(info.mode & 0o777, 0o600)
})

test('a corrupt state file is reported instead of replaced', async (t) => {
  const dir = await makeTempDir('state')
  t.after(() => cleanup(dir))
  const file = join(dir, 'state', 'bot1.json')
  await mkdir(join(dir, 'state'), { recursive: true })
  await writeFile(file, '{not json', 'utf8')

  const state = new ChannelState({ stateDir: dir, botId: 'bot1' })
  await assert.rejects(() => state.load(), /not valid JSON/)
})
