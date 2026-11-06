/**
 * Single-poller ownership lock.
 *
 * One bot token may have exactly one active long poller: the iLink session is
 * per account, and a second poller makes both fail with `-14`. The lock is a
 * local advisory file, so it protects one host (or one container) from a second
 * gateway process; it cannot coordinate replicas on different hosts.
 * Fully initialized records are published with an exclusive hard link.
 *
 * @module dsh-weixin-gateway/store/lock
 */

import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureDir, writeJsonAtomic } from './atomic.mjs'
import { silentLogger } from '../util/log.mjs'

const DEFAULT_STALE_MS = 120_000
const TOUCH_INTERVAL_MS = 15_000
const runFile = promisify(execFile)
let bootIdentity
let ownIdentity
/** Bounded retries when a contender keeps losing a lock race. */
const ACQUIRE_ATTEMPTS = 3

/** Raised when another live process owns the bot's poller lock. */
export class LockError extends Error {
  /**
   * @param {string} message - human-facing reason.
   * @param {object} [holder] - description of the owning process.
   */
  constructor(message, holder) {
    super(message)
    this.name = 'LockError'
    this.code = 'locked'
    this.holder = holder
  }
}

/**
 * Probe whether a pid is alive on this host.
 *
 * @param {number} pid - process id.
 * @returns {boolean} true when the process exists or access is denied.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function readProcessIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      bootIdentity ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((value) => value.trim())
      const bootId = await bootIdentity
      const document = await readFile(`/proc/${pid}/stat`, 'utf8')
      const startTime = document.slice(document.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
      if (bootId && /^\d+$/.test(startTime ?? '')) return { bootId, startTime }
    } else if (process.platform === 'darwin') {
      bootIdentity ??= runFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2000 })
        .then(({ stdout }) => stdout.trim())
      const bootId = await bootIdentity
      const { stdout } = await runFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        timeout: 2000,
      })
      const startTime = stdout.trim()
      if (bootId && startTime) return { bootId, startTime }
    }
  } catch {}
  return null
}

export function getProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  // This process's generation cannot change during its lifetime.
  if (pid === process.pid) return ownIdentity ??= readProcessIdentity(pid)
  return readProcessIdentity(pid)
}

/**
 * Read and parse the current lock document.
 *
 * @param {string} lockPath - lock file path.
 * @returns {Promise<object|null>} parsed holder, or null when absent.
 */
async function readHolder(lockPath) {
  let text
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const holder = JSON.parse(text)
    if (typeof holder?.token !== 'string' || holder.token.length === 0 ||
        typeof holder?.host !== 'string' || holder.host.length === 0 ||
        !Number.isInteger(holder?.pid) || holder.pid <= 0) {
      throw new Error('invalid lock record')
    }
    if (holder.processIdentity !== undefined &&
        (typeof holder.processIdentity?.bootId !== 'string' || holder.processIdentity.bootId.length === 0 ||
         typeof holder.processIdentity?.startTime !== 'string' || holder.processIdentity.startTime.length === 0)) {
      throw new Error('invalid process identity')
    }
    return holder
  } catch {
    throw new LockError(`poller lock ${lockPath} is unreadable; inspect it before removing it`)
  }
}

/**
 * Decide whether an existing lock may be taken over.
 *
 * @param {object} holder - parsed lock document.
 * @param {object} context - local process and heartbeat probes.
 * @returns {Promise<boolean>} true when the lock is abandoned.
 */
async function isStale(holder, { host, staleMs, probeProcessIdentity }) {
  if (holder.host === host) {
    if (!isProcessAlive(holder.pid)) return true
    if (holder.processIdentity === undefined) return false
    const current = await probeProcessIdentity(holder.pid)
    if (current === null) return false
    return current.bootId !== holder.processIdentity.bootId || current.startTime !== holder.processIdentity.startTime
  }
  const heartbeat = Number(holder.heartbeat ?? holder.startedAt ?? 0)
  return !Number.isFinite(heartbeat) || Date.now() - heartbeat > staleMs
}

function busy(lockPath, holder) {
  return new LockError(`another gateway owns bot poller ${lockPath} (pid ${holder.pid} on ${holder.host})`, {
    pid: holder.pid,
    host: holder.host,
    startedAt: holder.startedAt,
  })
}

async function publish(temp, lockPath) {
  try {
    await link(temp, lockPath)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

async function releaseFile(lockPath, record) {
  const holder = await readHolder(lockPath)
  if (holder?.token === record.token) await rm(lockPath, { force: true })
}

async function acquireFile(lockPath, temp, record, context) {
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    if (await publish(temp, lockPath)) return
    const holder = await readHolder(lockPath)
    if (holder === null) continue
    if (!(await isStale(holder, context))) throw busy(lockPath, holder)

    // All stale removals share a claim lock, including recovery of an abandoned claim.
    const claimPath = `${lockPath}.claim`
    await acquireFile(claimPath, temp, record, context)
    try {
      const current = await readHolder(lockPath)
      if (current === null) continue
      if (current.token !== holder.token || !(await isStale(current, context))) continue
      await rm(lockPath)
      if (await publish(temp, lockPath)) {
        context.logger.warn('taking over a stale poller lock', {
          previousPid: holder.pid,
          previousHost: holder.host,
        })
        return
      }
    } finally {
      await releaseFile(claimPath, record)
    }
  }
  throw new LockError(`could not claim bot poller ${lockPath}: the lock kept changing`)
}

/**
 * Acquire the poller lock or fail.
 *
 * @param {string} lockPath - lock file path.
 * @param {object} [options] - acquisition options.
 * @param {number} [options.pid] - pid to record.
 * @param {string} [options.host] - host to record.
 * @param {number} [options.staleMs] - heartbeat age after which a lock is abandoned.
 * @param {number} [options.now] - clock override for tests.
 * @param {object} [options.logger] - logger.
 * @param {Function} [options.probeProcessIdentity] - process-generation probe; null means unknown.
 * @returns {Promise<{path: string, touch: Function, release: Function, holder: object}>} lock handle.
 * @throws {LockError} when a live owner holds the lock.
 */
export async function acquireLock(
  lockPath,
  {
    pid = process.pid,
    host = hostname(),
    staleMs = DEFAULT_STALE_MS,
    now = Date.now(),
    logger = silentLogger,
    probeProcessIdentity = getProcessIdentity,
  } = {},
) {
  await ensureDir(dirname(lockPath))
  const token = randomBytes(8).toString('hex')
  const processIdentity = await probeProcessIdentity(pid)
  const record = {
    version: 1, pid, host, token, startedAt: now, heartbeat: now,
    ...(processIdentity === null ? {} : { processIdentity }),
  }

  const temp = `${lockPath}.${token}.tmp`
  try {
    await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    await acquireFile(lockPath, temp, record, { host, staleMs, logger, probeProcessIdentity })
    return makeHandle(lockPath, record)
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * Build the small handle returned to the owner.
 *
 * @param {string} lockPath - lock file path.
 * @param {object} record - our lock document.
 * @returns {{path: string, touch: Function, release: Function, holder: object}} handle.
 */
function makeHandle(lockPath, record) {
  let lastTouch = record.heartbeat
  return {
    path: lockPath,
    holder: { pid: record.pid, host: record.host, startedAt: record.startedAt },
    /**
     * Refresh the heartbeat so another process does not treat this lock as stale.
     *
     * @returns {Promise<void>} resolves after the throttled write.
     */
    async touch() {
      const current = await readHolder(lockPath)
      if (current?.token !== record.token) throw new LockError('poller lock ownership was lost')
      const now = Date.now()
      if (now - lastTouch < TOUCH_INTERVAL_MS) return
      await writeJsonAtomic(lockPath, { ...record, heartbeat: now })
      lastTouch = now
    },
    /**
     * Release the lock if this process still owns it.
     *
     * @returns {Promise<void>} resolves once released.
     */
    async release() {
      await releaseFile(lockPath, record)
    },
  }
}
