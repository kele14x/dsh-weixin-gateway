import test from 'node:test'
import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { acquireLock, getProcessIdentity, LockError, isProcessAlive } from '../src/store/lock.mjs'
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

test('native process identity is stable and persisted through heartbeats', async (t) => {
  const dir = await makeTempDir('lock-generation')
  t.after(() => cleanup(dir))
  const identity = await getProcessIdentity(process.pid)
  if (process.platform === 'linux' || process.platform === 'darwin') {
    assert.ok(identity?.bootId)
    assert.ok(identity?.startTime)
  } else {
    assert.equal(identity, null)
  }
  assert.deepEqual(await getProcessIdentity(process.pid), identity)
  const source = `
    import { getProcessIdentity } from ${JSON.stringify(new URL('../src/store/lock.mjs', import.meta.url).href)}
    process.stdout.write(JSON.stringify(await getProcessIdentity(${process.pid})))
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, LC_ALL: 'en_US.UTF-8', TZ: 'America/New_York' },
  })
  assert.deepEqual(JSON.parse(stdout), identity)
  assert.equal(await getProcessIdentity(0), null)
  assert.equal(await getProcessIdentity(999_999), null)
  const path = join(dir, 'bot1.lock')
  const lock = await acquireLock(path, { now: 1 })
  t.after(() => lock.release())
  const before = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(before.processIdentity ?? null, identity)
  await lock.touch()
  const after = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(after.processIdentity ?? null, identity)
})

for (const scenario of ['valid', 'missing', 'denied']) {
  test(`Linux process-identity parsing with ${scenario} proc fixtures`, async () => {
    const source = `
      import fs from 'node:fs/promises'
      import { syncBuiltinESMExports } from 'node:module'
      const originalReadFile = fs.readFile
      fs.readFile = async (path, ...args) => {
        if (path === '/proc/sys/kernel/random/boot_id') {
          if (${JSON.stringify(scenario)} === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' })
          return 'fixture-boot\\n'
        }
        if (path === '/proc/' + process.pid + '/stat') {
          if (${JSON.stringify(scenario)} === 'missing') throw Object.assign(new Error('gone'), { code: 'ENOENT' })
          return process.pid + ' (worker (with) spaces) S ' + '0 '.repeat(18) + '123456 0'
        }
        return originalReadFile(path, ...args)
      }
      syncBuiltinESMExports()
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const { getProcessIdentity } = await import(${JSON.stringify(new URL('../src/store/lock.mjs', import.meta.url).href)})
      process.stdout.write(JSON.stringify(await getProcessIdentity(process.pid)))
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source])
    assert.deepEqual(JSON.parse(stdout), scenario === 'valid' ? { bootId: 'fixture-boot', startTime: '123456' } : null)
  })
}

for (const mismatch of ['bootId', 'startTime']) {
  test(`a live reused pid with a different ${mismatch} can be recovered`, async (t) => {
    const dir = await makeTempDir('lock-pid-reuse')
    t.after(() => cleanup(dir))
    const path = join(dir, 'bot1.lock')
    const current = { bootId: 'current-boot', startTime: 'current-start' }
    await writeFile(path, JSON.stringify({
      pid: process.pid, host: hostname(), token: 'abandoned', heartbeat: Date.now(),
      processIdentity: { ...current, [mismatch]: 'previous-generation' },
    }))
    const lock = await acquireLock(path, { probeProcessIdentity: async () => current })
    t.after(() => lock.release())
    const record = JSON.parse(await readFile(path, 'utf8'))
    assert.notEqual(record.token, 'abandoned')
    assert.deepEqual(record.processIdentity, current)
  })
}

for (const available of [true, false]) {
  test(`an old heartbeat cannot evict a live owner with ${available ? 'matching' : 'unverifiable'} generation`, async (t) => {
    const dir = await makeTempDir('lock-live-generation')
    t.after(() => cleanup(dir))
    const path = join(dir, 'bot1.lock')
    const identity = { bootId: 'boot', startTime: 'start' }
    const holder = { pid: process.pid, host: hostname(), token: 'live', heartbeat: 1, processIdentity: identity }
    await writeFile(path, JSON.stringify(holder))
    await assert.rejects(() => acquireLock(path, {
      staleMs: 1, probeProcessIdentity: async () => available ? identity : null,
    }), LockError)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), holder)
  })
}

test('a live owner without generation metadata remains protected', async (t) => {
  const dir = await makeTempDir('lock-no-generation')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'live', heartbeat: 1 }))
  await assert.rejects(() => acquireLock(path, { staleMs: 1 }), LockError)
})

test('five contenders recover a reused-pid lock and abandoned claims with one winner', async (t) => {
  const dir = await makeTempDir('lock-generation-race')
  t.after(() => cleanup(dir))
  const path = join(dir, 'bot1.lock')
  const current = { bootId: 'boot', startTime: 'current' }
  const abandoned = JSON.stringify({
    pid: process.pid, host: hostname(), token: 'abandoned', heartbeat: 1,
    processIdentity: { ...current, startTime: 'previous' },
  })
  await Promise.all([path, `${path}.claim`, `${path}.claim.claim`].map((file) => writeFile(file, abandoned)))
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireLock(path, {
    probeProcessIdentity: async () => current,
  })))
  const owners = results.filter((result) => result.status === 'fulfilled')
  assert.equal(owners.length, 1)
  t.after(() => owners[0].value.release())
  for (const loser of results.filter((result) => result.status === 'rejected')) assert.ok(loser.reason instanceof LockError)
  assert.deepEqual(await readdir(dir), ['bot1.lock'])
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
  for (const document of ['', '{broken', '{}', 'null',
    JSON.stringify({ pid: 0, host: hostname(), token: 'invalid' }),
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'invalid', processIdentity: null }),
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'invalid', processIdentity: { bootId: 'boot' } }),
  ]) {
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
