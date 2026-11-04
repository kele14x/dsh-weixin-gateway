/**
 * Shared test helpers: temp directories and polling assertions.
 *
 * All temp state lives under one workspace-local root, and a file-level `after`
 * hook sweeps it once every per-test hook has run. That matters because a
 * gateway `stop()` registered after a per-test cleanup can write state back into
 * a directory that was just removed.
 *
 * @module test/helpers/tmp
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after } from 'node:test'

// Each test file runs in its own process; a shared root would be deleted by a
// sibling file's teardown while this file is still using it.
const ROOT = join(process.cwd(), `.tmp-test-${process.pid}`)

after(async () => {
  await rm(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/**
 * Create a temp directory inside the workspace (the sandbox denies most others).
 *
 * @param {string} [label] - directory label.
 * @returns {Promise<string>} absolute path.
 */
export async function makeTempDir(label = 'weixin') {
  await mkdir(ROOT, { recursive: true })
  return mkdtemp(join(ROOT, `${label}-`))
}

/**
 * Remove a temp directory recursively.
 *
 * @param {string} dir - directory path.
 * @returns {Promise<void>} resolves once removed.
 */
export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

/**
 * Poll until a predicate holds.
 *
 * @param {() => boolean} predicate - condition.
 * @param {object} [options] - polling options.
 * @param {number} [options.timeoutMs] - budget.
 * @param {number} [options.intervalMs] - interval.
 * @param {string} [options.message] - assertion message.
 * @returns {Promise<void>} resolves when the predicate holds.
 * @throws {Error} when the budget expires.
 */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(intervalMs)
  }
  throw new Error(`timed out waiting for ${message}`)
}
