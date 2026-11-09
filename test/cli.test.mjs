import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { PassThrough } from 'node:stream'
import { createLoginIo, main, parseArgs } from '../bin/dsh-weixin.mjs'
import { LoginError, runQrLogin } from '../src/ilink/auth.mjs'
import { ILinkClient } from '../src/ilink/client.mjs'
import { AccountStore, safeBotId } from '../src/store/accounts.mjs'
import { ChannelState } from '../src/store/state.mjs'
import { acquireLock } from '../src/store/lock.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

function captureOutput(t) {
  const output = { logs: [], errors: [] }
  t.mock.method(console, 'log', (...args) => output.logs.push(args.join(' ')))
  t.mock.method(console, 'error', (...args) => output.errors.push(args.join(' ')))
  return output
}

async function storeFixture(stateDir, botId = 'bot-1') {
  const accounts = new AccountStore({ stateDir })
  const accountPath = await accounts.save({ botId, botToken: 'private-token', baseUrl: 'https://api.test' })
  const state = new ChannelState({ stateDir, botId })
  await mkdir(state.dir, { recursive: true })
  await writeFile(state.file, JSON.stringify({ cursor: 'stored-cursor', sessions: { sender: 'session' } }))
  const allowedPath = join(stateDir, 'allowed.json')
  await writeFile(allowedPath, JSON.stringify({ senders: ['sender'] }))
  return [accountPath, state.file, allowedPath, accounts.activeFile]
}

async function snapshot(paths) {
  return Promise.all(paths.map((path) => readFile(path, 'utf8')))
}

test('malformed value flags fail before deleting anything in the default state directory', async (t) => {
  captureOutput(t)
  const home = await makeTempDir('cli-home')
  t.after(() => cleanup(home))
  const stateDir = join(home, 'integrations', 'dsh-weixin')
  const paths = await storeFixture(stateDir)
  const original = await snapshot(paths)

  for (const flag of ['--state-dir', '--base-url']) {
    for (const tail of [[], [''], ['   '], ['--yes'], ['-y'], ['--force'], [' --no-qr'], [flag]]) {
      const argv = ['logout', '--yes', flag, ...tail]
      assert.throws(() => parseArgs(argv), /requires a nonempty value/)
      assert.equal(await main(argv, { DSH_HOME: home }), 2)
      assert.deepEqual(await snapshot(paths), original)
    }
  }
})

test('valid CLI values and flags retain their meaning', () => {
  assert.deepEqual(parseArgs(['login', '--state-dir', '/tmp/state dir', '--base-url', 'https://api.test', '--force', '--no-qr', '--show-url']), {
    command: 'login',
    stateDir: '/tmp/state dir',
    baseUrl: 'https://api.test',
    force: true,
    yes: false,
    noQr: true,
    showUrl: true,
  })
})

test('logout refuses a live owner and status uses the sanitized lock path', async (t) => {
  const output = captureOutput(t)
  const stateDir = await makeTempDir('cli-locked')
  t.after(() => cleanup(stateDir))
  const botId = 'bot/one'
  const paths = await storeFixture(stateDir, botId)
  const lockPath = join(stateDir, 'lock', `${safeBotId(botId)}.lock`)
  const owner = await acquireLock(lockPath)
  try {
    const original = await snapshot([...paths, lockPath])
    assert.equal(await main(['logout', '--state-dir', stateDir, '--yes']), 1)
    assert.deepEqual(await snapshot([...paths, lockPath]), original)
    assert.ok(output.errors.some((line) => /Stop the owning gateway and retry logout/.test(line)))
    assert.equal(await main(['status', '--state-dir', stateDir]), 0)
    assert.ok(output.logs.some((line) => /lock:\s+held/.test(line)))
  } finally {
    await owner.release()
  }
})

test('logout removes idle credentials and state and releases its own lock', async (t) => {
  captureOutput(t)
  const stateDir = await makeTempDir('cli-logout')
  t.after(() => cleanup(stateDir))
  const botId = 'bot/one'
  const paths = await storeFixture(stateDir, botId)
  const lockPath = join(stateDir, 'lock', `${safeBotId(botId)}.lock`)
  assert.equal(await main(['logout', '--state-dir', stateDir, '--yes']), 0)
  for (const path of [...paths, lockPath]) {
    await assert.rejects(() => readFile(path), { code: 'ENOENT' })
  }
  const nextOwner = await acquireLock(lockPath)
  await nextOwner.release()
})

test('logout releases its lock when credential deletion fails', async (t) => {
  captureOutput(t)
  const stateDir = await makeTempDir('cli-logout-failure')
  t.after(() => cleanup(stateDir))
  const paths = await storeFixture(stateDir)
  const original = await snapshot(paths)
  t.mock.method(AccountStore.prototype, 'remove', async () => { throw new Error('remove failed') })
  await assert.rejects(() => main(['logout', '--state-dir', stateDir, '--yes']), /remove failed/)
  assert.deepEqual(await snapshot(paths), original)
  const lockPath = join(stateDir, 'lock', `${safeBotId('bot-1')}.lock`)
  await assert.rejects(() => readFile(lockPath), { code: 'ENOENT' })
  const nextOwner = await acquireLock(lockPath)
  await nextOwner.release()
})

test('forced login replaces the active account and logout cannot reactivate an older credential', async (t) => {
  const output = captureOutput(t)
  const stateDir = await makeTempDir('cli-switch-account')
  t.after(() => cleanup(stateDir))
  const accounts = new AccountStore({ stateDir })
  await accounts.save({ botId: 'old-bot', botToken: 'old-token', baseUrl: 'https://api.test' })
  t.mock.method(ILinkClient.prototype, 'getBotQrcode', async () => ({ qrcode: 'offline-qr' }))
  t.mock.method(ILinkClient.prototype, 'getQrcodeStatus', async () => ({
    status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'new-bot', baseurl: 'https://api.test',
  }))

  assert.equal(await main(['login', '--state-dir', stateDir, '--force', '--no-qr']), 0)
  assert.equal((await accounts.active()).botId, 'new-bot')
  // Windows has no POSIX mode bits and reports every regular file as 0o666.
  if (process.platform !== 'win32') {
    assert.equal((await stat(accounts.activeFile)).mode & 0o777, 0o600)
  }
  assert.equal(await main(['status', '--state-dir', stateDir]), 0)
  assert.ok(output.logs.includes('active account: new-bot'))
  assert.equal(await main(['logout', '--state-dir', stateDir, '--yes']), 0)

  const reopened = new AccountStore({ stateDir })
  assert.equal(await reopened.active(), null)
  assert.equal(await reopened.load('new-bot'), null)
  assert.equal((await reopened.load('old-bot')).botToken, 'old-token')
  assert.equal(await main(['status', '--state-dir', stateDir]), 0)
  assert.ok(output.logs.includes('active account: (none)'))
  assert.equal(await main(['logout', '--state-dir', stateDir, '--yes']), 0)
  assert.equal((await reopened.load('old-bot')).botToken, 'old-token')
})

test('a failed forced login keeps the previous active account', async (t) => {
  captureOutput(t)
  const stateDir = await makeTempDir('cli-failed-login')
  t.after(() => cleanup(stateDir))
  const accounts = new AccountStore({ stateDir })
  await accounts.save({ botId: 'old-bot', botToken: 'old-token', baseUrl: 'https://api.test' })
  t.mock.method(ILinkClient.prototype, 'getBotQrcode', async () => ({ qrcode: 'offline-qr' }))
  t.mock.method(ILinkClient.prototype, 'getQrcodeStatus', async () => ({ status: 'expired' }))

  assert.equal(await main(['login', '--state-dir', stateDir, '--force', '--no-qr']), 1)
  assert.equal((await accounts.active()).botId, 'old-bot')
})

test('removing an inactive credential keeps the selected account', async (t) => {
  const stateDir = await makeTempDir('cli-inactive-account')
  t.after(() => cleanup(stateDir))
  const accounts = new AccountStore({ stateDir })
  await accounts.save({ botId: 'old-bot', botToken: 'old-token', baseUrl: 'https://api.test' })
  await accounts.save({ botId: 'new-bot', botToken: 'new-token', baseUrl: 'https://api.test' })
  const path = accounts.pathFor('old-bot')
  const old = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...old, savedAt: Date.now() + 60_000 }))
  assert.equal((await accounts.active()).botId, 'new-bot')
  await accounts.remove('old-bot')
  assert.equal((await accounts.active()).botId, 'new-bot')
})

test('a failed active-selection write does not activate the saved credential', async (t) => {
  const stateDir = await makeTempDir('cli-selection-failure')
  t.after(() => cleanup(stateDir))
  const accounts = new AccountStore({ stateDir })
  await mkdir(accounts.activeFile)
  await assert.rejects(() => accounts.save({ botId: 'bot', botToken: 'token', baseUrl: 'https://api.test' }))
  await rm(accounts.activeFile, { recursive: true })
  assert.equal(await accounts.active(), null)
  assert.equal((await accounts.load('bot')).botId, 'bot')
})

for (const reason of ['timeout', 'aborted']) {
  test(`CLI readline verification input itself terminates on ${reason}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const input = new PassThrough()
    const output = new PassThrough()
    const readline = createInterface({ input, output, terminal: false })
    t.after(() => {
      readline.close()
      input.destroy()
      output.destroy()
    })
    const controller = new AbortController()
    const client = {
      baseUrl: 'https://api.test',
      async getBotQrcode() { return { qrcode: 'offline-qr' } },
      async getQrcodeStatus() { return { status: 'need_verifycode' } },
    }
    const adapter = createLoginIo(readline)
    let prompted
    const started = new Promise((resolve) => { prompted = resolve })
    let inputError
    const io = {
      print() {},
      prompt(question, options) {
        const answer = adapter.prompt(question, options)
        answer.catch((error) => { inputError = error })
        prompted()
        return answer
      },
    }
    const login = runQrLogin({ client, io, signal: controller.signal, now: () => 0, timeoutMs: 100 })
    const failed = assert.rejects(login, (error) => error instanceof LoginError && error.code === reason)
    await started
    if (reason === 'timeout') t.mock.timers.tick(100)
    else controller.abort()
    await failed
    assert.equal(inputError?.name, 'AbortError')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    const nextAnswer = readline.question('Next: ')
    input.write('still usable\n')
    assert.equal(await nextAnswer, 'still usable')
    t.mock.timers.tick(1000)
  })
}
