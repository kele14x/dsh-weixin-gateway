/**
 * Cordis plugin entry.
 *
 * The plugin waits for `sessionController` (the `web` profile composes it) and
 * mounts the gateway on its own fiber, so a live patch reload disposes the
 * poller cleanly before the replacement starts.
 *
 * @module dsh-weixin-gateway
 */

import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { Config } from './config.mjs'
import { createLogger } from './util/log.mjs'
import { createHost } from './bridge/host.mjs'
import { Gateway } from './runtime.mjs'

export const name = 'dsh-weixin-gateway'
export { Config }

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
  if (typeof config.defaultCwd !== 'string' || !isAbsolute(config.defaultCwd)) {
    logger.error('defaultCwd must be an absolute path; the WeChat channel is disabled', {
      defaultCwd: config.defaultCwd,
    })
    return
  }
  if (!isDirectory(config.defaultCwd)) {
    logger.error('defaultCwd is not an existing directory; the WeChat channel is disabled', {
      defaultCwd: config.defaultCwd,
    })
    return
  }

  ctx.inject(['sessionController'], (child) => {
    child.effect(() => {
      let gateway
      let starting
      try {
        const host = createHost(child, { logger })
        gateway = new Gateway({ config, host, logger })
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
