import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRouter, HELP_TEXT, parseCommand, safeEqual } from '../src/bridge/commands.mjs'

/**
 * Build a router over a fake allowlist.
 *
 * @param {object} [options] - options.
 * @param {boolean} [options.allowed] - pre-allow `u1`.
 * @param {object} [options.actions] - action overrides.
 * @returns {{router: CommandRouter, allowList: object}} router and allowlist.
 */
function makeRouter({ allowed = false, actions = {} } = {}) {
  const allowList = {
    users: new Set(allowed ? ['u1'] : []),
    isAllowed(userId) {
      return this.users.has(userId)
    },
    async allow(userId) {
      this.users.add(userId)
    },
  }
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
  return { router, allowList }
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

  const { router, allowList } = makeRouter()
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

  const { router, allowList } = makeRouter()
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'bind', args: ['nope'] },
    isAllowed: false,
  })
  assert.match(outcome.reply, /not valid/)
  assert.equal(allowList.isAllowed('u1'), false)
})

test('pairing is disabled when the environment variable is unset', async (t) => {
  const previous = process.env.DSH_WEIXIN_BIND_CODE
  delete process.env.DSH_WEIXIN_BIND_CODE
  t.after(() => {
    if (previous !== undefined) process.env.DSH_WEIXIN_BIND_CODE = previous
  })

  const { router } = makeRouter()
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

  const { router } = makeRouter()
  let reply = ''
  for (let attempt = 0; attempt < 6; attempt += 1) {
    reply = (
      await router.handle({ userId: 'u1', command: { name: 'bind', args: ['wrong'] }, isAllowed: false })
    ).reply
  }
  assert.match(reply, /Too many pairing attempts/)
})

test('an unpaired sender gets the pairing hint for other commands', async () => {
  const { router } = makeRouter()
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'help', args: [] },
    isAllowed: false,
  })
  assert.equal(outcome.handled, true)
  assert.match(outcome.reply, /not paired/)
})

test('a paired sender gets help, status, and version', async () => {
  const { router } = makeRouter({ allowed: true })
  const help = await router.handle({ userId: 'u1', command: { name: 'help', args: [] }, isAllowed: true })
  assert.equal(help.reply, HELP_TEXT)

  const status = await router.handle({ userId: 'u1', command: { name: 'status', args: [] }, isAllowed: true })
  assert.equal(status.reply, 'status-text')

  const version = await router.handle({ userId: 'u1', command: { name: 'version', args: [] }, isAllowed: true })
  assert.equal(version.reply, 'version-text')
})

test('an unknown slash command falls through to the agent', async () => {
  const { router } = makeRouter({ allowed: true })
  const outcome = await router.handle({
    userId: 'u1',
    command: { name: 'model', args: ['x'] },
    isAllowed: true,
  })
  assert.equal(outcome.handled, false)
})
