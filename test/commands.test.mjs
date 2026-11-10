import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { CommandRouter, HELP_TEXT, parseCommand, safeEqual } from '../src/bridge/commands.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { issuePairingCode, pairingFile } from '../src/store/pairing.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

function withoutEnvCode(t) {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  delete process.env.DSH_WEIXIN_BIND_CODE
  t.after(() => {
    if (previous !== undefined) process.env.DSH_WEIXIN_BIND_CODE = previous
  })
}

async function makeRouter(t, { allowed = false, actions = {}, stateDir } = {}) {
  const dir = stateDir ?? await makeTempDir('commands')
  if (stateDir === undefined) t.after(() => cleanup(dir))
  const allowList = new AllowList({ stateDir: dir })
  await allowList.load()
  if (allowed) await allowList.allow('u1')
  const router = new CommandRouter({
    actions: {
      status: () => 'status-text',
      stop: () => 'stop-text',
      newSession: async () => 'new-text',
      version: () => 'version-text',
      ...actions,
    },
    allowed: allowList,
    config: { bindCodeEnv: 'DSH_WEIXIN_BIND_CODE', stateDir: dir },
  })
  return { router, allowList, stateDir: dir }
}

test('parseCommand reads a leading slash command', () => {
  assert.deepEqual(parseCommand('/bind abc'), { name: 'bind', args: ['abc'], raw: '/bind abc' })
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand('/'), null)
  assert.equal(parseCommand('/UPPER').name, 'upper')
})

test('permission commands require exactly one prompt id and map to one-shot outcomes', async (t) => {
  const calls = []
  const { router } = await makeRouter(t, {
    allowed: true,
    actions: { approval: (userId, response) => { calls.push({ userId, ...response }); return 'decision sent' } },
  })
  const id = '7'
  for (const [name, outcome] of [['allow', 'allowed-once'], ['deny', 'rejected']]) {
    const response = await router.handle({ userId: 'u1', command: { name, args: [id] }, isAllowed: true })
    assert.deepEqual(response, { handled: true, reply: 'decision sent' })
    assert.deepEqual(calls.at(-1), { userId: 'u1', id, outcome })
    for (const args of [[], ['all'], [id, 'always'], ['DEADBEEFDEADBEEF'], ['bad-id'], ['0'], ['01'], ['-1'], ['1.5'], ['1e2'], ['9007199254740992'], ['0123456789abcdef']]) {
      const invalid = await router.handle({ userId: 'u1', command: { name, args }, isAllowed: true })
      assert.equal(invalid.handled, true)
      assert.match(invalid.reply, /Usage:/)
    }
  }
  assert.equal(calls.length, 2)
})

test('unpaired permission commands never invoke an approval action', async (t) => {
  const { router } = await makeRouter(t, {
    actions: { approval: () => assert.fail('unpaired approvals must be denied') },
  })
  for (const name of ['allow', 'deny']) {
    const outcome = await router.handle({
      userId: 'u1', command: { name, args: ['7'] }, isAllowed: false,
    })
    assert.equal(outcome.handled, true)
    assert.match(outcome.reply, /not paired/)
  }
})

test('safeEqual compares secrets exactly', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
})

test('an unpaired sender can bind with the configured code', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'pair-me'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router, allowList } = await makeRouter(t)
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'bind', args: ['pair-me'] },
    isAllowed: false,
  })
  assert.equal(outcome.handled, true)
  assert.match(outcome.reply, /Paired/)
  assert.equal(allowList.isAllowed('u1'), true)
})

test('a wrong pairing code does not grant access', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'pair-me'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router, allowList } = await makeRouter(t)
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'bind', args: ['nope'] },
    isAllowed: false,
  })
  assert.match(outcome.reply, /not valid/)
  assert.equal(allowList.isAllowed('u1'), false)
  const valid = await router.handle({
    userId: 'u1',
    command: { name: 'bind', args: ['pair-me'] },
    isAllowed: false,
  })
  assert.match(valid.reply, /^Paired\./)
})

test('pairing is not open when no code is issued and the environment variable is unset', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  delete process.env.DSH_WEIXIN_BIND_CODE
  t.after(() => {
    if (previous !== undefined) process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router } = await makeRouter(t)
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'bind', args: ['anything'] },
    isAllowed: false,
  })
  assert.match(outcome.reply, /not open.*dsh-weixin pair/)
})

test('repeated wrong codes are rate limited', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'pair-me'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router } = await makeRouter(t)
  let reply = ''
  for (let attempt = 0; attempt < 6; attempt += 1) {
    reply = (
      await router.handle({ userId: 'u1', command: { name: 'bind', args: ['wrong'] }, isAllowed: false })
    ).reply
  }
  assert.match(reply, /Too many pairing attempts/)
})

test('an unpaired sender gets the pairing hint for other commands', async (t) => {
  const { router } = await makeRouter(t)
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'help', args: [] },
    isAllowed: false,
  })
  assert.equal(outcome.handled, true)
  assert.match(outcome.reply, /not paired/)
})

test('a paired sender gets help, status, and version', async (t) => {
  const { router } = await makeRouter(t, { allowed: true })
  const help = await router.handle({ userId: 'u1', command: { name: 'help', args: [] }, isAllowed: true })
  assert.equal(help.reply, HELP_TEXT)

  const status = await router.handle({ userId: 'u1', command: { name: 'status', args: [] }, isAllowed: true })
  assert.equal(status.reply, 'status-text')

  const version = await router.handle({ userId: 'u1', command: { name: 'version', args: [] }, isAllowed: true })
  assert.equal(version.reply, 'version-text')
})

test('an unknown slash command falls through to the agent', async (t) => {
  const { router } = await makeRouter(t, { allowed: true })
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'model', args: ['x'] },
    isAllowed: true,
  })
  assert.equal(outcome.handled, false)
})

test('concurrent binds consume the code once and tell the loser how to rotate it', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'one-use-code'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router, allowList } = await makeRouter(t)
  const outcomes = await Promise.all(['u1', 'u2'].map((userId) => router.handle({
    userId,
    command: { name: 'bind', args: ['one-use-code'] },
    isAllowed: false,
  })))
  // File reads can complete in either order; only one durable winner matters.
  const winner = outcomes.findIndex((outcome) => /^Paired\./.test(outcome.reply))
  assert.notEqual(winner, -1)
  const loser = 1 - winner
  assert.match(outcomes[loser].reply, /already been redeemed/)
  assert.match(outcomes[loser].reply, /operator.*different code.*DSH_WEIXIN_BIND_CODE/)
  assert.equal(allowList.isAllowed(['u1', 'u2'][winner]), true)
  assert.equal(allowList.isAllowed(['u1', 'u2'][loser]), false)
})

test('bind rejects consumed codes after restart and accepts a distinct rotated code', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  process.env.DSH_WEIXIN_BIND_CODE = 'original-code'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router, stateDir } = await makeRouter(t)
  const bind = (router, userId, code) => router.handle({
    userId,
    command: { name: 'bind', args: [code] },
    isAllowed: false,
  })
  assert.match((await bind(router, 'u1', 'original-code')).reply, /^Paired\./)

  const reopened = await makeRouter(t, { stateDir })
  assert.match((await bind(reopened.router, 'u2', 'original-code')).reply, /already been redeemed/)
  assert.equal(reopened.allowList.isAllowed('u2'), false)

  process.env.DSH_WEIXIN_BIND_CODE = 'rotated-code'
  assert.match((await bind(reopened.router, 'u1', 'rotated-code')).reply, /already paired/)
  assert.match((await bind(reopened.router, 'u2', 'rotated-code')).reply, /^Paired\./)
  process.env.DSH_WEIXIN_BIND_CODE = 'original-code'
  const restarted = await makeRouter(t, { stateDir })
  assert.match((await bind(restarted.router, 'u3', 'original-code')).reply, /already been redeemed/)
  assert.equal(restarted.allowList.isAllowed('u3'), false)
})

const bind = (router, userId, code) => router.handle({
  userId,
  command: { name: 'bind', args: [code] },
  isAllowed: false,
})

test('an issued code pairs without the environment variable or a restart and is single use', async (t) => {
  withoutEnvCode(t)
  const { router, allowList, stateDir } = await makeRouter(t)
  assert.match((await bind(router, 'u1', 'whatever')).reply, /not open/)

  const first = await issuePairingCode(stateDir)
  assert.match(first.code, /^[a-hj-km-np-z2-9]{8}$/)
  assert.match((await bind(router, 'u1', first.code.toUpperCase())).reply, /^Paired\./)
  assert.equal(allowList.isAllowed('u1'), true)

  const replay = (await bind(router, 'u2', first.code)).reply
  assert.match(replay, /already been redeemed.*dsh-weixin pair/)
  assert.equal(allowList.isAllowed('u2'), false)

  const second = await issuePairingCode(stateDir)
  assert.match((await bind(router, 'u2', first.code)).reply, /not valid/)
  assert.match((await bind(router, 'u2', second.code)).reply, /^Paired\./)
})

test('an expired issued code is refused while the environment code still works', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_WEIXIN_BIND_CODE
    else process.env.DSH_WEIXIN_BIND_CODE = previous
  })
  delete process.env.DSH_WEIXIN_BIND_CODE

  const { router, allowList, stateDir } = await makeRouter(t)
  const { code } = await issuePairingCode(stateDir, { now: Date.now() - 60_000, ttlMs: 1_000 })
  assert.match((await bind(router, 'u1', code)).reply, /not open/)
  assert.equal(allowList.isAllowed('u1'), false)

  process.env.DSH_WEIXIN_BIND_CODE = 'env-code'
  assert.match((await bind(router, 'u1', code)).reply, /not valid/)
  assert.match((await bind(router, 'u1', 'env-code')).reply, /^Paired\./)
})

test('an issued code is stored only as an owner-only hash and a corrupt file is ignored', async (t) => {
  withoutEnvCode(t)
  const { router, stateDir } = await makeRouter(t)
  const { code } = await issuePairingCode(stateDir)
  const file = pairingFile(stateDir)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await readFile(file, 'utf8')).includes(code), false)

  await writeFile(file, '{not json')
  assert.match((await bind(router, 'u1', code)).reply, /not open/)
})
