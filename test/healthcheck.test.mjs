import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

const execute = promisify(execFile)
const script = new URL('../examples/docker/healthcheck.mjs', import.meta.url)
const liveHolder = { pid: process.pid, token: 'test-token', host: hostname() }

async function fixture(t) {
  const home = await makeTempDir('healthcheck')
  t.after(() => cleanup(home))
  const lockDir = join(home, 'integrations', 'dsh-weixin', 'lock')
  await mkdir(lockDir, { recursive: true })
  return { home, lockDir, lock: join(lockDir, 'test.lock') }
}

async function runHealthcheck(home, bootstrap) {
  const args = bootstrap === undefined
    ? [script.pathname]
    : ['--input-type=module', '--eval', `${bootstrap}\nawait import(${JSON.stringify(script.href)})`]
  try {
    const output = await execute(process.execPath, args, {
      env: { ...process.env, DSH_HOME: home },
      timeout: 5000,
    })
    return { code: 0, ...output }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

function assertUnhealthy(result, message) {
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, message ?? /^unhealthy:/)
}

test('healthcheck accepts a fresh valid lock with an actual live PID', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(liveHolder))
  const result = await runHealthcheck(home)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^healthy: last poll \d+s ago\n$/)
  assert.equal(result.stderr, '')
})

test('healthcheck rejects corrupt JSON', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, '{not valid JSON')
  assertUnhealthy(await runHealthcheck(home), /cannot read or verify poller lock/)
})

test('healthcheck validates holder shape without PID coercion', async (t) => {
  const cases = [
    ['zero PID', { ...liveHolder, pid: 0 }],
    ['negative PID', { ...liveHolder, pid: -1 }],
    ['string PID', { ...liveHolder, pid: String(process.pid) }],
    ['fractional PID', { ...liveHolder, pid: 1.5 }],
    ['null PID', { ...liveHolder, pid: null }],
    ['missing PID', { token: liveHolder.token, host: liveHolder.host }],
    ['boolean PID', { ...liveHolder, pid: true }],
    ['null holder', null],
    ['array holder', []],
    ['string holder', 'holder'],
    ['empty object', {}],
    ['missing token', { pid: process.pid, host: liveHolder.host }],
    ['empty token', { ...liveHolder, token: '' }],
    ['blank token', { ...liveHolder, token: '   ' }],
    ['nonstring token', { ...liveHolder, token: 123 }],
    ['null token', { ...liveHolder, token: null }],
    ['missing host', { pid: process.pid, token: liveHolder.token }],
    ['empty host', { ...liveHolder, host: '' }],
    ['blank host', { ...liveHolder, host: '   ' }],
    ['nonstring host', { ...liveHolder, host: 123 }],
    ['null host', { ...liveHolder, host: null }],
  ]
  for (const [name, holder] of cases) {
    await t.test(name, async (t) => {
      const { home, lock } = await fixture(t)
      await writeFile(lock, JSON.stringify(holder))
      // Invalid records must fail before even attempting a signal-0 probe.
      const bootstrap = `process.kill = () => { throw new Error('unexpected PID probe') }`
      assertUnhealthy(await runHealthcheck(home, bootstrap), /invalid poller lock holder/)
    })
  }
})

test('healthcheck rejects a PID from an already exited disposable child', async (t) => {
  const { home, lock } = await fixture(t)
  const exited = await execute(process.execPath, ['--eval', 'process.stdout.write(String(process.pid))'])
  await writeFile(lock, JSON.stringify({ ...liveHolder, pid: Number(exited.stdout) }))
  assertUnhealthy(await runHealthcheck(home), /poller pid is gone/)
})

test('healthcheck rejects non-ESRCH PID verification errors', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(liveHolder))
  const bootstrap = `
    process.kill = (pid, signal) => {
      if (pid !== ${process.pid} || signal !== 0) throw new Error('unexpected PID or signal')
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    }
  `
  assertUnhealthy(await runHealthcheck(home, bootstrap), /cannot read or verify poller lock/)
})

test('healthcheck rejects a positive integer PID outside the process API range', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify({ ...liveHolder, pid: Number.MAX_SAFE_INTEGER }))
  assertUnhealthy(await runHealthcheck(home), /cannot read or verify poller lock/)
})

test('healthcheck rejects an empty or absent lock directory', async (t) => {
  const { home } = await fixture(t)
  assertUnhealthy(await runHealthcheck(home), /no poller lock/)
  assertUnhealthy(await runHealthcheck(join(home, 'absent')), /no poller lock/)
})

test('healthcheck rejects a lock disappearing before stat', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(liveHolder))
  const bootstrap = `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const originalStat = fs.stat
    fs.stat = async (file, ...args) => {
      await fs.unlink(file)
      return originalStat(file, ...args)
    }
    syncBuiltinESMExports()
  `
  assertUnhealthy(await runHealthcheck(home, bootstrap), /poller lock disappeared/)
})

test('healthcheck rejects a selected lock disappearing before read', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(liveHolder))
  const bootstrap = `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const originalReadFile = fs.readFile
    fs.readFile = async (file, ...args) => {
      await fs.unlink(file)
      return originalReadFile(file, ...args)
    }
    syncBuiltinESMExports()
  `
  assertUnhealthy(await runHealthcheck(home, bootstrap), /cannot read or verify poller lock/)
})

test('healthcheck rejects other lock read errors', async (t) => {
  const { home, lock } = await fixture(t)
  await mkdir(lock)
  assertUnhealthy(await runHealthcheck(home), /cannot read or verify poller lock/)
})

test('healthcheck rejects a stale lock even with a live PID', async (t) => {
  const { home, lock } = await fixture(t)
  await writeFile(lock, JSON.stringify(liveHolder))
  const stale = new Date(Date.now() - 180_000)
  await utimes(lock, stale, stale)
  assertUnhealthy(await runHealthcheck(home), /last successful poll was \d+s ago/)
})
