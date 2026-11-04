/**
 * Single-poller ownership lock.
 *
 * One bot token may have exactly one active long poller: the iLink session is
 * per account, and a second poller makes both fail with `-14`. The lock is a
 * local advisory file, so it protects one host (or one container) from a second
 * gateway process; it cannot coordinate replicas on different hosts. Creation
 * is exclusive (`wx`), and a stale lock is moved aside with `rename` before it
 * is replaced, so two contenders cannot both take over the same abandoned lock.
 *
 * @module dsh-weixin-gateway/store/lock
 */

import { link, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { ensureDir } from './atomic.mjs'
import { silentLogger } from '../util/log.mjs'

const DEFAULT_STALE_MS = 120_000
const TOUCH_INTERVAL_MS = 15_000
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

/**
 * Read and parse the current lock document.
 *
 * @param {string} lockPath - lock file path.
 * @returns {Promise<object|null>} parsed holder, or null when absent/unreadable.
 */
async function readHolder(lockPath) {
  try {
    const text = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * Decide whether an existing lock may be taken over.
 *
 * @param {object} holder - parsed lock document.
 * @param {{host: string, now: number, staleMs: number}} context - local context.
 * @returns {boolean} true when the lock is abandoned.
 */
function isStale(holder, { host, now, staleMs }) {
  const sameHost = holder.host === host
  if (sameHost && !isProcessAlive(Number(holder.pid))) return true
  const lastBeat = Number(holder.heartbeat ?? holder.startedAt ?? 0)
  if (!Number.isFinite(lastBeat) || lastBeat <= 0) return true
  return now - lastBeat > staleMs
}

/**
 * Create the lock file exclusively and write its record.
 *
 * @param {string} lockPath - lock file path.
 * @param {object} record - lock document.
 * @returns {Promise<boolean>} true when this process created the file.
 */
async function createLockFile(lockPath, record) {
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify(record))
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  return true
}

/**
 * Move a stale lock aside so exactly one contender can replace it.
 *
 * `rename` is atomic and requires its source to exist, so when two processes
 * decide the same lock is abandoned, only one of them wins the move; the other
 * sees `ENOENT` and retries from the top. The winner then re-reads the inode it
 * actually moved, because the staleness decision was made from an earlier read:
 * a lock that is live at this point is linked back rather than stolen.
 *
 * @param {string} lockPath - lock file path.
 * @param {string} token - this contender's token.
 * @param {{host: string, staleMs: number, logger: object}} context - staleness context.
 * @returns {Promise<{outcome: 'claimed'|'gone'|'busy', holder: object|null}>} claim result.
 */
async function claimStaleLock(lockPath, token, { host, staleMs, logger }) {
  const claimed = `${lockPath}.claim-${token}`
  try {
    await rename(lockPath, claimed)
  } catch (error) {
    if (error.code === 'ENOENT') return { outcome: 'gone', holder: null }
    throw error
  }

  const holder = await readHolder(claimed)
  if (holder !== null && !isStale(holder, { host, now: Date.now(), staleMs })) {
    logger.warn('a poller lock moved aside as stale was live; restoring it', { pid: holder.pid })
    try {
      await link(claimed, lockPath)
    } catch (error) {
      if (error.code === 'EEXIST') {
        // A newer owner published its own lock between our rename and this
        // link; the displaced record cannot be restored without clobbering it.
        logger.warn('a live poller lock was displaced while a newer lock appeared', { pid: holder.pid })
      } else {
        logger.warn('could not restore a live poller lock', { reason: error.message })
      }
    }
    await rm(claimed, { force: true })
    return { outcome: 'busy', holder }
  }

  await rm(claimed, { force: true })
  return { outcome: 'claimed', holder }
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
 * @returns {Promise<{path: string, touch: Function, release: Function, holder: object}>} lock handle.
 * @throws {LockError} when a live owner holds the lock.
 */
export async function acquireLock(
  lockPath,
  { pid = process.pid, host = hostname(), staleMs = DEFAULT_STALE_MS, now = Date.now(), logger = silentLogger } = {},
) {
  await ensureDir(dirname(lockPath))
  const token = randomBytes(8).toString('hex')
  const record = { version: 1, pid, host, token, startedAt: now, heartbeat: now }

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    if (await createLockFile(lockPath, record)) return makeHandle(lockPath, record, logger)

    const holder = await readHolder(lockPath)
    if (holder !== null && !isStale(holder, { host, now: Date.now(), staleMs })) {
      throw new LockError(
        `another gateway owns bot poller ${lockPath} (pid ${holder.pid} on ${holder.host})`,
        { pid: holder.pid, host: holder.host, startedAt: holder.startedAt },
      )
    }

    const claim = await claimStaleLock(lockPath, token, { host, staleMs, logger })
    if (claim.outcome === 'busy') {
      throw new LockError(
        `another gateway owns bot poller ${lockPath} (pid ${claim.holder.pid} on ${claim.holder.host})`,
        { pid: claim.holder.pid, host: claim.holder.host, startedAt: claim.holder.startedAt },
      )
    }
    if (claim.outcome === 'claimed') {
      logger.warn('taking over a stale poller lock', {
        previousPid: claim.holder?.pid,
        previousHost: claim.holder?.host,
      })
    }
  }

  throw new LockError(
    `could not claim bot poller ${lockPath}: the lock kept changing (${ACQUIRE_ATTEMPTS} attempts)`,
  )
}

/**
 * Build the small handle returned to the owner.
 *
 * @param {string} lockPath - lock file path.
 * @param {object} record - our lock document.
 * @param {object} logger - logger.
 * @returns {{path: string, touch: Function, release: Function, holder: object}} handle.
 */
function makeHandle(lockPath, record, logger) {
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
      const now = Date.now()
      if (now - lastTouch < TOUCH_INTERVAL_MS) return
      lastTouch = now
      const current = await readHolder(lockPath)
      if (current?.token !== record.token) {
        logger.warn('poller lock was taken over; heartbeat skipped')
        return
      }
      await writeFile(lockPath, JSON.stringify({ ...record, heartbeat: now }), { mode: 0o600 }).catch(
        (error) => logger.warn('poller lock heartbeat failed', { reason: error.message }),
      )
    },
    /**
     * Release the lock if this process still owns it.
     *
     * @returns {Promise<void>} resolves once released.
     */
    async release() {
      const current = await readHolder(lockPath)
      if (current !== null && current.token !== record.token) return
      await rm(lockPath, { force: true })
    },
  }
}
