/**
 * Cordis plugin entry.
 *
 * The plugin waits for `sessionController` (the `web` profile composes it) and
 * mounts the gateway on its own fiber, so a live patch reload disposes the
 * poller cleanly before the replacement starts. A channel that fails at runtime
 * is restarted for a bounded window, because a stopped poller can neither report
 * nor repair itself.
 *
 * @module dsh-weixin-gateway
 */

import { isAbsolute, join, resolve } from 'node:path'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config, DEFAULT_WORKSPACE_TITLE } from './config.mjs'
import { createLogger } from './util/log.mjs'
import { createHost } from './bridge/host.mjs'
import { WorkspaceBinder } from './bridge/workspace.mjs'
import { Gateway } from './runtime.mjs'

export const name = 'dsh-weixin-gateway'
export { Config }

/** Repository/package root, derived from this module's location. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Default directory for sessions this channel creates.
 *
 * @returns {string} absolute path to the plugin's `workspace/` directory.
 */
export function defaultWorkspace() {
  return join(PACKAGE_ROOT, 'workspace')
}

/**
 * Check that a configured directory exists.
 *
 * @param {string} path - directory path.
 * @returns {boolean} true when it is a directory.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Recovery window after the channel reports a fatal error. */
const RECOVERY_BUDGET_MS = 60_000

/** First restart delay; it doubles after each attempt inside the window. */
const RECOVERY_BASE_DELAY_MS = 1000

/**
 * Start the gateway and retry a fatal failure for a bounded window.
 *
 * A channel that reached `error` has stopped polling, so nothing inside it can
 * report or repair the failure: no WeChat command can arrive and the Host has no
 * readout of the channel. `Gateway.start()` already recovers from `error`, it
 * just had no caller. Retry with a doubling delay for `budgetMs`, then give up
 * with one actionable line, because a permanent misconfiguration must not emit a
 * log line per interval for the rest of the process lifetime. A start that ends
 * anywhere but `error` closes the episode, so a later failure gets a fresh
 * budget.
 *
 * @param {import('./runtime.mjs').Gateway} gateway - channel to supervise.
 * @param {object} logger - plugin logger.
 * @param {object} [options] - overrides, for tests.
 * @param {number} [options.budgetMs] - recovery window per episode; 0 disables retrying.
 * @param {number} [options.baseDelayMs] - first retry delay.
 * @returns {{dispose: () => Promise<void>|undefined}} handle; `dispose` cancels a pending retry and returns the in-flight attempt.
 */
export function startWithRecovery(gateway, logger, {
  budgetMs = RECOVERY_BUDGET_MS,
  baseDelayMs = RECOVERY_BASE_DELAY_MS,
} = {}) {
  let timer
  let pending
  let deadline = 0
  let delay = baseDelayMs
  let disposed = false
  let exhausted = false

  /**
   * Queue the next restart, or give up once the episode budget is spent.
   *
   * One failure reaches this twice — through `onFatal` and through the rejected
   * start — so a pending timer or a finished episode ends the call immediately.
   *
   * @param {Error} error - failure being recovered from.
   * @returns {void}
   */
  function schedule(error) {
    if (disposed || exhausted || timer !== undefined) return
    if (deadline === 0) {
      deadline = Date.now() + budgetMs
      delay = baseDelayMs
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      exhausted = true
      logger.error(
        'the WeChat channel stopped and every recovery attempt failed; restart the DSH Host to resume polling',
        { reason: error?.message, retryWindowMs: budgetMs },
      )
      return
    }
    const wait = Math.min(delay, remaining)
    delay *= 2
    logger.warn('the WeChat channel stopped; retrying', { reason: error?.message, retryInMs: wait })
    timer = setTimeout(() => {
      timer = undefined
      attempt()
    }, wait)
    timer.unref?.()
  }

  /** Run one start attempt and fold its outcome back into the episode. */
  function attempt() {
    if (disposed) return
    const started = gateway.start().then(
      () => {
        // Anywhere but `error` ends the episode, so a later failure gets a fresh
        // budget; `locked` and `unconfigured` have their own diagnostics.
        if (gateway.status !== 'error') {
          deadline = 0
          exhausted = false
        }
      },
      (error) => {
        logger.error('the WeChat gateway failed to start', error)
        schedule(error)
      },
    )
    pending = started
    started.then(() => {
      if (pending === started) pending = undefined
    })
  }

  gateway.onFatal = schedule
  attempt()

  return {
    dispose() {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      gateway.onFatal = undefined
      return pending
    },
  }
}

/**
 * Mount the WeChat channel on a Host that composes the Session Controller.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - resolved plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const logger = createLogger({
    level: config.logLevel ?? 'info',
    content: config.debugLogContent === true,
    prefix: '[weixin]',
  })

  if (typeof config.stateDir !== 'string' || !isAbsolute(config.stateDir)) {
    logger.error('stateDir must be an absolute path; the WeChat channel is disabled', {
      stateDir: config.stateDir,
    })
    return
  }
  const configuredCwd = typeof config.defaultCwd === 'string' ? config.defaultCwd.trim() : ''
  let defaultCwd
  if (configuredCwd.length > 0) {
    defaultCwd = resolve(configuredCwd)
    if (!isAbsolute(defaultCwd) || !isDirectory(defaultCwd)) {
      logger.error('defaultCwd is not an existing directory; the WeChat channel is disabled', {
        defaultCwd,
      })
      return
    }
  } else {
    // No explicit workspace: keep WeChat files beside the plugin instead of in
    // whatever directory the Host was launched from.
    defaultCwd = defaultWorkspace()
    try {
      mkdirSync(defaultCwd, { recursive: true, mode: 0o700 })
    } catch (error) {
      logger.error('could not create the plugin workspace directory; the WeChat channel is disabled', {
        defaultCwd,
        reason: error.message,
      })
      return
    }
  }
  const resolvedConfig = { ...config, defaultCwd }

  // Grouping is cosmetic: without the registry (headless profiles) or with an
  // empty title the channel runs exactly as before and Sessions stay ungrouped.
  const workspaceTitle = (
    typeof config.workspaceTitle === 'string' ? config.workspaceTitle : DEFAULT_WORKSPACE_TITLE
  ).trim()
  const workspace =
    workspaceTitle.length === 0
      ? undefined
      : new WorkspaceBinder({
          stateDir: config.stateDir,
          dir: defaultCwd,
          title: workspaceTitle,
          logger,
        })

  ctx.inject(['sessionController'], (child) => {
    child.effect(() => {
      let gateway
      let recovery
      try {
        const host = createHost(child, { logger })
        gateway = new Gateway({ config: resolvedConfig, host, workspace, logger })
        recovery = startWithRecovery(gateway, logger)
      } catch (error) {
        logger.error('the WeChat gateway could not be created', error)
        return () => {}
      }

      return async () => {
        await recovery.dispose()?.catch(() => {})
        await gateway.stop().catch((error) => {
          logger.error('the WeChat gateway failed to stop cleanly', error)
        })
      }
    }, 'weixin-gateway')

    if (workspace === undefined) return

    // The registry is optional: a profile without it leaves the channel
    // ungrouped rather than disabled. This effect also runs when the service
    // becomes available later, so a slow profile still groups its Sessions.
    child.inject(['workspaceRegistry'], (registryCtx) => {
      registryCtx.effect(() => {
        workspace.use(registryCtx.workspaceRegistry)
        workspace.adopt().catch((error) => {
          logger.warn('could not group existing WeChat conversations', { reason: error.message })
        })
        return () => workspace.detach()
      }, 'weixin-workspace')
    })
  })
}
