#!/usr/bin/env node
/**
 * Operator CLI: QR login, status, and logout.
 *
 * This never starts a poller. It writes credentials for the running gateway to
 * pick up on its next start, which keeps the one-poller rule intact.
 *
 * @module dsh-weixin-gateway/bin
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { AccountStore, maskToken, safeBotId } from '../src/store/accounts.mjs'
import { acquireLock, LockError } from '../src/store/lock.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { clearPairingCode, issuePairingCode, readPairingCode } from '../src/store/pairing.mjs'
import { ILinkClient } from '../src/ilink/client.mjs'
import { LoginError, runQrLogin } from '../src/ilink/auth.mjs'
import { VERSION, botAgentFor } from '../src/ilink/constants.mjs'

const USAGE = `dsh-weixin ${VERSION}

Usage:
  dsh-weixin login   [--state-dir <path>] [--base-url <url>] [--force] [--no-qr] [--show-url]
  dsh-weixin pair    [--state-dir <path>]
  dsh-weixin status  [--state-dir <path>]
  dsh-weixin logout  [--state-dir <path>] [--yes]

State directory defaults to $DSH_HOME/integrations/dsh-weixin, or
~/.dsh/integrations/dsh-weixin when DSH_HOME is unset.

login scans a QR code and stores bot credentials (mode 0600).
pair prints a one-time /bind code valid for 15 minutes; the running gateway
accepts it without a restart, and running pair again replaces it.
status prints accounts and cursor/session counts; it never prints tokens.
logout removes the stored account, its state, its allowlist, and any pending code.`

/**
 * Parse argv into a command and flags.
 *
 * @param {string[]} argv - process arguments after the script name.
 * @returns {{command: string, stateDir?: string, baseUrl?: string, force: boolean, yes: boolean, noQr: boolean, showUrl: boolean}} parsed CLI input.
 */
export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = { command, force: false, yes: false, noQr: false, showUrl: false }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    switch (argument) {
      case '--state-dir':
      case '--base-url': {
        const value = rest[++index]
        if (typeof value !== 'string' || value.trim().length === 0 || value.trim().startsWith('-')) {
          throw new Error(`${argument} requires a nonempty value (not an option)`)
        }
        options[argument === '--state-dir' ? 'stateDir' : 'baseUrl'] = value
        break
      }
      case '--force':
        options.force = true
        break
      case '--yes':
      case '-y':
        options.yes = true
        break
      case '--no-qr':
        options.noQr = true
        break
      case '--show-url':
        options.showUrl = true
        break
      default:
        throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

/**
 * Resolve the state directory the same way the bundle patch does.
 *
 * @param {string|undefined} override - `--state-dir` value.
 * @param {NodeJS.ProcessEnv} [env] - environment.
 * @returns {string} absolute state directory.
 */
export function resolveStateDir(override, env = process.env) {
  if (override !== undefined) return resolve(override)
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) {
    return join(resolve(env.DSH_HOME), 'integrations', 'dsh-weixin')
  }
  return join(homedir(), '.dsh', 'integrations', 'dsh-weixin')
}

/**
 * Render a scannable QR code, falling back to the payload URL.
 *
 * @param {{qrcode?: string, qrcodeImgContent?: string}} qr - QR payload.
 * @returns {Promise<void>} resolves after rendering.
 */
async function renderQr({ qrcode, qrcodeImgContent }) {
  const payload =
    typeof qrcodeImgContent === 'string' && qrcodeImgContent.length > 0 ? qrcodeImgContent : qrcode
  if (typeof payload !== 'string' || payload.length === 0) {
    console.log('The server returned no QR payload; scan the URL printed by the login flow instead.')
    return
  }
  try {
    const module = await import('qrcode-terminal')
    const generator = module.default ?? module
    generator.generate(payload, { small: true }, (rendered) => console.log(rendered))
  } catch {
    console.log(`QR payload: ${payload}`)
  }
}

export function createLoginIo(readline) {
  return {
    print: (line) => console.log(line),
    prompt: async (question, { signal } = {}) => (await readline.question(question, { signal })).trim(),
  }
}

/**
 * `dsh-weixin login`.
 *
 * @param {object} options - parsed CLI options.
 * @param {AccountStore} accounts - account store.
 * @returns {Promise<number>} exit code.
 */
async function login(options, accounts) {
  const existing = await accounts.active()
  if (existing !== null && options.force !== true) {
    console.log(`An account is already active: ${existing.botId} (token ${maskToken(existing.botToken)}).`)
    console.log('Start the DSH Host (dsh web) to run the gateway.')
    console.log('Re-run with --force only if you intend to replace the bot credential.')
    return 0
  }

  console.log('Starting WeChat QR login ...')
  const client = new ILinkClient({
    baseUrl: options.baseUrl,
    botAgent: botAgentFor(VERSION),
  })

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const io = createLoginIo(readline)

  try {
    const credentials = await runQrLogin({
      client,
      io,
      // Give an operator enough time to fetch a phone and scan.
      timeoutMs: 300_000,
      localTokens: existing === null ? [] : [existing.botToken],
      onQrcode:
        options.noQr === true
          ? undefined
          : (qr) => {
              if (options.showUrl === true) {
                const payload =
                  typeof qr.qrcodeImgContent === 'string' && qr.qrcodeImgContent.length > 0
                    ? qr.qrcodeImgContent
                    : qr.qrcode
                if (typeof payload === 'string' && payload.length > 0) {
                  console.log(`QR payload (open this on the phone, or scan below): ${payload}`)
                }
              }
              return renderQr(qr)
            },
    })

    const path = await accounts.save({
      ...credentials,
      botAgent: botAgentFor(VERSION),
    })

    console.log('')
    console.log('Login succeeded.')
    console.log(`  bot id:   ${credentials.botId}`)
    console.log(`  token:    ${maskToken(credentials.botToken)}`)
    console.log(`  base url: ${credentials.baseUrl}`)
    console.log(`  owner:    ${credentials.ownerUserId ?? '(unknown)'}`)
    console.log(`  stored:   ${path}`)
    console.log('')
    console.log('Next: start the DSH Host (dsh web), run "dsh-weixin pair" for a pairing code,')
    console.log('then send the bot a direct message: /bind <code>.')
    return 0
  } catch (error) {
    if (error instanceof LoginError) {
      console.error(`Login failed (${error.code}): ${error.message}`)
      return 1
    }
    console.error(`Login failed: ${error.message}`)
    return 1
  } finally {
    readline.close()
  }
}

/**
 * `dsh-weixin pair`.
 *
 * @param {string} stateDir - state directory.
 * @returns {Promise<number>} exit code.
 */
async function pair(stateDir) {
  const { code, expiresAt } = await issuePairingCode(stateDir)
  console.log(`Pairing code: ${code}`)
  console.log(`Expires:      ${new Date(expiresAt).toLocaleString()} (single use)`)
  console.log('')
  console.log(`Send this to the bot from WeChat:  /bind ${code}`)
  console.log('The running gateway accepts it immediately; no restart is needed.')
  console.log('Running pair again replaces this code.')
  return 0
}

/**
 * Describe the pending pairing code without revealing it.
 *
 * @param {string} stateDir - state directory.
 * @param {AllowList} allowed - loaded allowlist.
 * @returns {Promise<string>} one-line description.
 */
async function pairingSummary(stateDir, allowed) {
  let issued
  try {
    issued = await readPairingCode(stateDir)
  } catch (error) {
    return `unreadable (${error.message})`
  }
  if (issued === null) return 'no code issued (run: dsh-weixin pair)'
  if (allowed.hasConsumed(issued.codeHash)) return 'last code redeemed (run pair for another)'
  if (issued.expiresAt <= Date.now()) return 'last code expired (run pair for another)'
  return `code pending until ${new Date(issued.expiresAt).toLocaleString()}`
}

/**
 * `dsh-weixin status`.
 *
 * @param {object} options - parsed CLI options.
 * @param {string} stateDir - state directory.
 * @param {AccountStore} accounts - account store.
 * @returns {Promise<number>} exit code.
 */
async function status(options, stateDir, accounts) {
  const records = await accounts.list()
  if (records.length === 0) {
    console.log(`No WeChat account stored in ${stateDir}. Run: dsh-weixin login`)
    return 0
  }

  const active = await accounts.active()
  console.log(`active account: ${active?.botId ?? '(none)'}`)
  const allowed = new AllowList({ stateDir })
  await allowed.load()
  console.log(`pairing:        ${await pairingSummary(stateDir, allowed)}`)
  console.log(`paired:         ${allowed.size} sender(s)`)
  console.log('')
  for (const record of records) {
    console.log(`account: ${record.botId}`)
    console.log(`  token:    ${maskToken(record.botToken)}`)
    console.log(`  base url: ${record.baseUrl}`)
    console.log(`  owner:    ${record.ownerUserId ?? '(unknown)'}`)
    console.log(`  saved:    ${new Date(record.savedAt ?? 0).toISOString()}`)

    const state = new ChannelState({ stateDir, botId: record.botId })
    try {
      await state.load()
      const summary = state.summary()
      console.log(`  cursor:   ${summary.cursorLength === 0 ? '(empty)' : 'stored'}`)
      console.log(`  sessions: ${summary.sessions} mapped`)
      console.log(`  contexts: ${summary.contextTokens} remembered`)
    } catch (error) {
      console.log(`  state:    unreadable (${error.message})`)
    }

    const lockPath = join(stateDir, 'lock', `${safeBotId(record.botId)}.lock`)
    console.log(`  lock:     ${existsSync(lockPath) ? 'held' : 'free'}`)
    console.log('')
  }
  return 0
}

/**
 * `dsh-weixin logout`.
 *
 * @param {object} options - parsed CLI options.
 * @param {string} stateDir - state directory.
 * @param {AccountStore} accounts - account store.
 * @returns {Promise<number>} exit code.
 */
async function logout(options, stateDir, accounts) {
  const record = await accounts.active()
  if (record === null) {
    await clearPairingCode(stateDir)
    console.log('No WeChat account to remove. Any pending pairing code has been cleared.')
    return 0
  }

  if (options.yes !== true) {
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await readline.question(`Remove ${record.botId}, its cursor/sessions, and pairings? [y/N] `)).trim()
    readline.close()
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Aborted.')
      return 1
    }
  }

  let lock
  try {
    lock = await acquireLock(join(stateDir, 'lock', `${safeBotId(record.botId)}.lock`))
  } catch (error) {
    if (!(error instanceof LockError)) throw error
    console.error(`Logout refused: ${error.message}. Stop the owning gateway and retry logout.`)
    return 1
  }

  try {
    await accounts.remove(record.botId)
    const state = new ChannelState({ stateDir, botId: record.botId })
    await state.load().catch(() => {})
    await rm(state.file, { force: true })
    await rm(join(stateDir, 'inbound', `${safeBotId(record.botId)}.json`), { force: true })
    await rm(join(stateDir, 'allowed.json'), { force: true })
    await clearPairingCode(stateDir)

    console.log(`Removed ${record.botId}.`)
    return 0
  } finally {
    await lock.release()
  }
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv] - argument override for tests.
 * @param {NodeJS.ProcessEnv} [env] - environment override.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    console.error(USAGE)
    return 2
  }

  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    console.log(USAGE)
    return 0
  }

  const stateDir = resolveStateDir(options.stateDir, env)
  const accounts = new AccountStore({ stateDir })

  switch (options.command) {
    case 'login':
      return login(options, accounts)
    case 'pair':
      return pair(stateDir)
    case 'status':
      return status(options, stateDir, accounts)
    case 'logout':
      return logout(options, stateDir, accounts)
    default:
      console.error(`unknown command: ${options.command}`)
      console.error(USAGE)
      return 2
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error)
      process.exit(1)
    },
  )
}
