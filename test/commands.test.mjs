import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRouter, HELP_TEXT, parseCommand, safeEqual } from '../src/bridge/commands.mjs'
import { AllowList } from '../src/store/allowed.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

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
    config: { bindCodeEnv: 'DSH_WEIXIN_BIND_CODE' },
  })
  return { router, allowList, stateDir: dir }
}

test('parseCommand reads a leading slash command', () => {
  assert.deepEqual(parseCommand('/bind abc'), { name: 'bind', args: ['abc'], raw: '/bind abc' })
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand('/'), null)
  assert.equal(parseCommand('/UPPER').name, 'upper')
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

test('pairing is disabled when the environment variable is unset', async (t) => {
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
  assert.match(outcome.reply, /disabled/)
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
  assert.match(outcomes[0].reply, /^Paired\./)
  assert.match(outcomes[1].reply, /already been redeemed/)
  assert.match(outcomes[1].reply, /operator.*different code.*DSH_WEIXIN_BIND_CODE/)
  assert.equal(allowList.isAllowed('u1'), true)
  assert.equal(allowList.isAllowed('u2'), false)
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
