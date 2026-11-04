import test from 'node:test'
import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { acquireLock, LockError, isProcessAlive } from '../src/store/lock.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

test('a second live owner is refused', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')

  const first = await acquireLock(path)
  await assert.rejects(() => acquireLock(path), LockError)
  await first.release()
  await acquireLock(path).then((second) => second.release())
})

test('a lock with a dead pid is taken over', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')

  const deadPid = 999_999
  assert.equal(isProcessAlive(deadPid), false)
  await writeFile(
    path,
    JSON.stringify({ version: 1, pid: deadPid, host: hostname(), token: 'old', startedAt: 1, heartbeat: Date.now() }),
  )

  const lock = await acquireLock(path)
  assert.equal(lock.holder.pid, process.pid)
  await lock.release()
})

test('a recent lock from another host is refused', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: 'another-host',
      token: 'remote',
      startedAt: Date.now(),
      heartbeat: Date.now(),
    }),
  )
  await assert.rejects(() => acquireLock(path, { staleMs: 60_000 }), LockError)
})

test('concurrent takeovers of a stale lock leave exactly one owner', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')

  await writeFile(
    path,
    JSON.stringify({ version: 1, pid: 999_999, host: hostname(), token: 'old', startedAt: 1, heartbeat: 1 }),
  )

  const results = await Promise.allSettled([acquireLock(path), acquireLock(path)])
  const owners = results.filter((result) => result.status === 'fulfilled')
  assert.equal(owners.length, 1)
  const loser = results.find((result) => result.status === 'rejected')
  assert.ok(loser.reason instanceof LockError)
  assert.deepEqual((await readdir(dir)).sort(), ['bot1.lock'])

  await owners[0].value.release()
})

test('release only removes our own lock', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')

  const lock = await acquireLock(path)
  const document = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(document.pid, process.pid)

  await lock.release()
  await assert.rejects(() => readFile(path, 'utf8'))
})
