import test from 'node:test'
import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import { spawn } from 'node:child_process'
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

for (const stale of [false, true]) {
  test(`five concurrent ${stale ? 'stale' : 'fresh'} lock contenders have one owner in 100 trials`, async (t) => {
    const dir = await makeTempDir('lock-stress')
    t.after(() => cleanup(dir))
    const path = join(dir, 'bot1.lock')
    for (let trial = 0; trial < 100; trial += 1) {
      if (stale) {
        await writeFile(path, JSON.stringify({ pid: 999_999, host: hostname(), token: 'old', heartbeat: 1 }))
      }
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireLock(path)))
      const owners = results.filter((result) => result.status === 'fulfilled')
      assert.equal(owners.length, 1, `trial ${trial}`)
      for (const loser of results.filter((result) => result.status === 'rejected')) {
        assert.ok(loser.reason instanceof LockError)
      }
      assert.deepEqual(await readdir(dir), ['bot1.lock'])
      await owners[0].value.touch()
      await owners[0].value.release()
    }
  })
}

for (const stale of [false, true]) {
  test(`five separate processes contend for a ${stale ? 'stale' : 'fresh'} lock`, { timeout: 20_000 }, async (t) => {
    const dir = await makeTempDir('lock-processes')
    t.after(() => cleanup(dir))
    const path = join(dir, 'bot1.lock')
    if (stale) {
      await writeFile(path, JSON.stringify({ pid: 999_999, host: hostname(), token: 'old', heartbeat: 1 }))
    }
    const source = `
      import { acquireLock } from ${JSON.stringify(new URL('../src/store/lock.mjs', import.meta.url).href)}
      let lock
      process.on('message', async (message) => {
        if (message === 'start') {
          try {
            lock = await acquireLock(process.argv[1])
            process.send({ owned: true })
          } catch (error) {
            process.send({ owned: false, code: error.code })
          }
        } else if (message === 'release') {
          await lock?.release()
          process.disconnect()
        }
      })
      process.send('ready')
    `
    const contenders = Array.from({ length: 5 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source, path], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      })
      const ready = new Promise((resolve, reject) => {
        child.once('message', resolve)
        child.once('error', reject)
      })
      const result = new Promise((resolve) => {
        child.on('message', (message) => {
          if (message !== 'ready') resolve(message)
        })
      })
      const exit = new Promise((resolve) => child.once('exit', resolve))
      return { child, ready, result, exit }
    })
    await Promise.all(contenders.map((contender) => contender.ready))
    for (const { child } of contenders) child.send('start')
    const results = await Promise.all(contenders.map((contender) => contender.result))
    assert.equal(results.filter((result) => result.owned).length, 1)
    for (const loser of results.filter((result) => !result.owned)) assert.equal(loser.code, 'locked')
    assert.deepEqual(await readdir(dir), ['bot1.lock'])
    for (const { child } of contenders) child.send('release')
    assert.deepEqual(await Promise.all(contenders.map((contender) => contender.exit)), [0, 0, 0, 0, 0])
    assert.deepEqual(await readdir(dir), [])
  })
}

test('an old heartbeat cannot evict a live process on this host', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  const lock = await acquireLock(path, { now: 1 })
  await assert.rejects(() => acquireLock(path, { staleMs: 1 }), LockError)
  await lock.release()
})

test('abandoned takeover claim locks are recovered', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  const abandoned = JSON.stringify({ pid: 999_999, host: hostname(), token: 'old', heartbeat: 1 })
  await Promise.all([path, `${path}.claim`, `${path}.claim.claim`].map((file) => writeFile(file, abandoned)))
  const lock = await acquireLock(path)
  assert.deepEqual(await readdir(dir), ['bot1.lock'])
  await lock.release()
})

test('incomplete or malformed lock records are refused rather than stolen', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  for (const document of ['', '{broken', '{}', 'null']) {
    await writeFile(path, document)
    await assert.rejects(() => acquireLock(path), /inspect it before removing it/)
    assert.equal(await readFile(path, 'utf8'), document)
    assert.deepEqual(await readdir(dir), ['bot1.lock'])
  }
})

test('ownership loss is detected even within the heartbeat throttle', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  const lock = await acquireLock(path)
  const replacement = { pid: process.pid, host: hostname(), token: 'replacement', heartbeat: Date.now() }
  await writeFile(path, JSON.stringify(replacement))
  await assert.rejects(() => lock.touch(), /ownership was lost/)
  await lock.release()
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement)
})

test('heartbeat replacement never exposes an incomplete document', async (t) => {
  const dir = await makeTempDir('lock')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  const lock = await acquireLock(path, { now: 1 })
  const before = JSON.parse(await readFile(path, 'utf8'))
  await Promise.all([
    lock.touch(),
    ...Array.from({ length: 100 }, async () => {
      const document = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(document.token, before.token)
    }),
  ])
  const after = JSON.parse(await readFile(path, 'utf8'))
  assert.ok(after.heartbeat > before.heartbeat)
  await lock.release()
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
