/**
 * Small filesystem helpers with the durability and permission rules this plugin
 * depends on: JSON state is written to a sibling temp file and renamed, and
 * every credential-bearing file is created with mode `0600`.
 *
 * @module dsh-weixin-gateway/store/atomic
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Raised when a state file exists but cannot be parsed. */
export class StateCorruptError extends Error {
  constructor(file, cause) {
    super(`state file is not valid JSON: ${file}`)
    this.name = 'StateCorruptError'
    this.code = 'state-corrupt'
    this.file = file
    this.cause = cause
  }
}

/**
 * Ensure a directory exists, preferring owner-only permissions.
 *
 * @param {string} dir - absolute directory path.
 * @returns {Promise<void>} resolves once the directory exists.
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file - file path.
 * @param {unknown} [fallback] - value returned when the file does not exist.
 * @returns {Promise<any>} parsed contents or the fallback.
 * @throws {StateCorruptError} when the file exists but is not valid JSON.
 */
export async function readJson(file, fallback = null) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new StateCorruptError(file, error)
  }
}

/**
 * Atomically write a JSON document.
 *
 * @param {string} file - destination path.
 * @param {unknown} value - JSON-serializable value.
 * @param {{mode?: number}} [options] - file mode after the write.
 * @returns {Promise<void>} resolves once the rename landed.
 */
export async function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  await ensureDir(dirname(file))
  const temp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  const payload = `${JSON.stringify(value, null, 2)}\n`
  try {
    await writeFile(temp, payload, { mode })
    await chmod(temp, mode).catch(() => {})
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Remove a file if it exists.
 *
 * @param {string} file - file path.
 * @returns {Promise<void>} resolves even when the file was absent.
 */
export async function removeFile(file) {
  await rm(file, { force: true })
}
