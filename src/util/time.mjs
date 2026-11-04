/**
 * Abortable sleep used by the poll loop, the chunk sender, and backoff paths.
 *
 * @module dsh-weixin-gateway/util/time
 */

/**
 * Build the error thrown when work is cancelled by a caller signal.
 *
 * @returns {Error} error tagged with `code: 'aborted'`.
 */
export function abortError() {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

/**
 * Wait for a number of milliseconds, waking early when the signal aborts.
 *
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal} [signal] - caller lifetime.
 * @returns {Promise<void>} resolves after the delay, rejects on abort.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Resolve with the outcome of `promise`, or reject once the signal aborts.
 * Used for operations that cannot take an AbortSignal themselves.
 *
 * @template T
 * @param {Promise<T>} promise - work to bound.
 * @param {AbortSignal} signal - caller lifetime.
 * @returns {Promise<T>} the original result or an abort rejection.
 */
export function raceAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
