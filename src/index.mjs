/**
 * Cordis plugin entry.
 *
 * The plugin waits for `sessionController` (the `web` profile composes it) and
 * mounts the gateway on its own fiber, so a live patch reload disposes the
 * poller cleanly before the replacement starts.
 *
 * @module dsh-weixin-gateway
 */

import { isAbsolute, join, resolve } from 'node:path'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Config } from './config.mjs'
import { createLogger } from './util/log.mjs'
import { createHost } from './bridge/host.mjs'
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

  ctx.inject(['sessionController'], (child) => {
    child.effect(() => {
      let gateway
      let starting
      try {
        const host = createHost(child, { logger })
        gateway = new Gateway({ config: resolvedConfig, host, logger })
        starting = gateway.start().catch((error) => {
          logger.error('the WeChat gateway failed to start', error)
        })
      } catch (error) {
        logger.error('the WeChat gateway could not be created', error)
        return () => {}
      }

      return async () => {
        await starting?.catch(() => {})
        await gateway.stop().catch((error) => {
          logger.error('the WeChat gateway failed to stop cleanly', error)
        })
      }
    }, 'weixin-gateway')
  })
}
