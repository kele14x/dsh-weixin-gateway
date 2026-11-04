/**
 * Redacting logger.
 *
 * Security rule for this plugin: bot tokens, context tokens, QR login URLs and
 * raw message text never reach a log sink. Redaction happens at the logger
 * boundary so that a careless call site cannot leak them.
 *
 * @module dsh-weixin-gateway/util/log
 */

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
})

const SECRET_KEY = /^(authorization|bottoken|bot_token|contexttoken|context_token|qrcode|qrcodevalue|typingticket|typing_ticket|password|secret|bindcode|bind_code)$/i

/**
 * Remove values that must never be persisted to logs from one string.
 *
 * @param {string} value - arbitrary text.
 * @returns {string} text with QR values and bearer tokens masked.
 */
export function scrubString(value) {
  return String(value)
    .replace(/qrcode=[^&\s"']+/gi, 'qrcode=[redacted]')
    .replace(/(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
}

/**
 * Deep-copy a value with secret-keyed fields and secret-looking strings masked.
 * Errors are reduced to name/message/code so stack traces never carry a token.
 *
 * @param {unknown} value - value to scrub.
 * @param {Set<object>} [seen] - cycle guard.
 * @returns {unknown} a log-safe representation.
 */
export function scrub(value, seen = new Set()) {
  if (typeof value === 'string') return scrubString(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(value.code === undefined ? {} : { code: value.code }),
      ...(value.status === undefined ? {} : { status: value.status }),
    }
  }
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => scrub(item, seen))
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[redacted]' : scrub(item, seen)
  }
  return output
}

/**
 * Create a small levelled logger.
 *
 * @param {object} [options] - logger options.
 * @param {'debug'|'info'|'warn'|'error'|'silent'} [options.level] - minimum level.
 * @param {boolean} [options.content] - allow raw message text at debug level.
 * @param {{log: Function, error: Function}} [options.sink] - output sink.
 * @param {string} [options.prefix] - line prefix.
 * @returns {object} logger with `debug/info/warn/error/contentDebug/child`.
 */
export function createLogger({ level = 'info', content = false, sink = console, prefix = '[dsh-weixin]' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  const emit = (name, message, fields) => {
    if ((LEVELS[name] ?? LEVELS.info) < threshold) return
    const line = `${new Date().toISOString()} ${prefix} ${name} ${scrubString(message)}`
    const tail = fields === undefined ? '' : ` ${JSON.stringify(scrub(fields))}`
    const text = `${line}${tail}\n`
    if (name === 'warn' || name === 'error') sink.error(text)
    else sink.log(text)
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    /** Log message text only when `debugLogContent` was explicitly enabled. */
    contentDebug: (message, fields) => {
      if (content) emit('debug', message, fields)
    },
    /** Derive a logger with a narrower prefix. */
    child: (childPrefix) =>
      createLogger({ level, content, sink, prefix: `${prefix} ${childPrefix}` }),
  }
}

/** A logger that discards everything, for unit tests of unrelated modules. */
export const silentLogger = createLogger({ level: 'silent' })
