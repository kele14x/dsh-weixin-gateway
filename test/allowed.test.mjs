import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AllowList } from '../src/store/allowed.mjs'
import { makeTempDir, cleanup } from './helpers/tmp.mjs'

async function makeAllowList(t) {
  const stateDir = await makeTempDir('allowed')
  t.after(() => cleanup(stateDir))
  const allowed = new AllowList({ stateDir })
  await allowed.load()
  return { allowed, stateDir }
}

async function reopen(stateDir) {
  const allowed = new AllowList({ stateDir })
  await allowed.load()
  return allowed
}

test('redemption atomically persists authorization and only a SHA256 code fingerprint', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  const code = 'secret-pairing-code'
  const pending = allowed.redeem('u1', code)
  assert.equal(allowed.isAllowed('u1'), false)
  assert.equal(await pending, true)

  const text = await readFile(allowed.file, 'utf8')
  const document = JSON.parse(text)
  assert.equal(typeof document.users.u1.boundAt, 'number')
  assert.deepEqual(document.consumedCodeHashes, [createHash('sha256').update(code).digest('hex')])
  assert.equal(text.includes(code), false)
  // Windows has no POSIX mode bits and reports every regular file as 0o666.
  if (process.platform !== 'win32') {
    assert.equal((await stat(allowed.file)).mode & 0o777, 0o600)
  }

  const restarted = await reopen(stateDir)
  assert.equal(restarted.isAllowed('u1'), true)
  assert.equal(await restarted.redeem('u2', code), false)
  assert.equal(restarted.isAllowed('u2'), false)
  assert.equal(await restarted.revoke('u1'), true)
  const revoked = await reopen(stateDir)
  assert.equal(await revoked.redeem('u1', code), false)
  assert.equal(await revoked.redeem('u2', 'distinct-rotated-code'), true)
  const rotated = await reopen(stateDir)
  assert.equal(await rotated.redeem('u3', code), false)
  assert.equal(await rotated.redeem('u3', 'distinct-rotated-code'), false)
  assert.equal(rotated.size, 1)
})

test('same-instance concurrent redeemers have exactly one durable winner', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  const userIds = Array.from({ length: 20 }, (_, index) => `u${index}`)
  const results = await Promise.all(userIds.map((userId) => allowed.redeem(userId, 'one-use')))
  assert.deepEqual(results, [true, ...Array(19).fill(false)])
  assert.equal(allowed.size, 1)
  const restarted = await reopen(stateDir)
  assert.equal(restarted.size, 1)
  assert.equal(restarted.isAllowed('u0'), true)
  assert.equal(await restarted.redeem('new-user', 'one-use'), false)
})

test('operator allow and revoke serialize with redemption without clobbering snapshots', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  const first = allowed.allow('alpha')
  assert.equal(allowed.isAllowed('alpha'), false)
  const results = await Promise.all([
    first,
    allowed.allow('beta'),
    allowed.revoke('alpha'),
    allowed.redeem('gamma', 'code-1'),
    allowed.allow('alpha'),
    allowed.revoke('beta'),
    allowed.redeem('delta', 'code-2'),
    allowed.flush(),
  ])
  assert.deepEqual(results, [true, true, true, true, true, true, true, undefined])
  const restarted = await reopen(stateDir)
  assert.deepEqual([...restarted.users.keys()].sort(), ['alpha', 'delta', 'gamma'])
  assert.equal(await restarted.redeem('other', 'code-1'), false)
  assert.equal(await restarted.redeem('other', 'code-2'), false)
  assert.deepEqual(await Promise.all([restarted.allow('other'), restarted.allow('other')]), [true, false])
  assert.deepEqual(await Promise.all([restarted.revoke('other'), restarted.revoke('other')]), [true, false])
})

test('failed redemption and operator writes publish nothing and leave the queue usable', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  await mkdir(allowed.file)
  const redemption = assert.rejects(allowed.redeem('u1', 'retry-code'))
  const operator = assert.rejects(allowed.allow('operator-user'))
  await Promise.all([redemption, operator])
  assert.equal(allowed.isAllowed('u1'), false)
  assert.equal(allowed.isAllowed('operator-user'), false)
  assert.equal(allowed.size, 0)
  await allowed.flush()
  await rm(allowed.file, { recursive: true })
  assert.equal(await allowed.redeem('u2', 'retry-code'), true)
  assert.equal(await allowed.allow('operator-user'), true)
  const restarted = await reopen(stateDir)
  assert.equal(restarted.isAllowed('u1'), false)
  assert.equal(restarted.isAllowed('u2'), true)
  assert.equal(restarted.isAllowed('operator-user'), true)
})

test('failed revocation preserves live and durable authorization', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  await allowed.redeem('u1', 'consumed-code')
  const file = allowed.file
  const blocked = join(stateDir, 'blocked')
  await mkdir(blocked)
  allowed.file = blocked
  const pending = allowed.revoke('u1')
  assert.equal(allowed.isAllowed('u1'), true)
  await assert.rejects(pending)
  assert.equal(allowed.isAllowed('u1'), true)
  allowed.file = file
  await allowed.flush()
  const restarted = await reopen(stateDir)
  assert.equal(restarted.isAllowed('u1'), true)
  assert.equal(await allowed.revoke('u1'), true)
  assert.equal(await allowed.redeem('u2', 'consumed-code'), false)
  assert.equal((await reopen(stateDir)).isAllowed('u1'), false)
})

test('legacy allowlists load and reload is ordered with queued mutations', async (t) => {
  const { allowed, stateDir } = await makeAllowList(t)
  await writeFile(allowed.file, JSON.stringify({ version: 1, users: { operator: { boundAt: 1 } } }))
  await allowed.load()
  assert.equal(allowed.isAllowed('operator'), true)
  assert.deepEqual(await Promise.all([
    allowed.redeem('u1', 'legacy-code'),
    allowed.load(),
    allowed.revoke('u1'),
    allowed.redeem('u2', 'legacy-code'),
  ]), [true, undefined, true, false])
  const restarted = await reopen(stateDir)
  assert.equal(restarted.isAllowed('operator'), true)
  assert.equal(restarted.isAllowed('u1'), false)
  assert.equal(restarted.isAllowed('u2'), false)
  assert.equal(await restarted.redeem('u3', 'legacy-code'), false)
})

test('invalid codes and already authorized senders do not consume a fresh code', async (t) => {
  const { allowed } = await makeAllowList(t)
  assert.equal(await allowed.redeem('u1', ''), false)
  assert.equal(await allowed.redeem('u1', undefined), false)
  await allowed.allow('u1')
  assert.equal(await allowed.redeem('u1', 'fresh-code'), false)
  assert.equal(await allowed.redeem('u2', 'fresh-code'), true)
})
