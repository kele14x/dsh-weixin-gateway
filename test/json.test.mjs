import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonPreservingIds } from '../src/ilink/json.mjs'
import { ILinkClient } from '../src/ilink/client.mjs'

test('parseJsonPreservingIds quotes uint64 id fields only', () => {
  const parsed = parseJsonPreservingIds(
    '{"ret":0,"message_id":18446744073709551615,"svr_id":9007199254740993,"nested":{"msg_id":42},"seq":7}',
  )
  assert.equal(parsed.ret, 0)
  assert.equal(parsed.message_id, '18446744073709551615')
  assert.equal(parsed.svr_id, '9007199254740993')
  assert.equal(parsed.nested.msg_id, '42')
  assert.equal(parsed.seq, 7)
})

test('parseJsonPreservingIds leaves id-like text inside strings untouched', () => {
  const parsed = parseJsonPreservingIds('{"text":"\\"message_id\\": 123","message_id":7}')
  assert.equal(parsed.text, '"message_id": 123')
  assert.equal(parsed.message_id, '7')
})

test('getUpdates preserves a uint64 message id as a string', async () => {
  const raw =
    '{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"u1","message_type":1}],"get_updates_buf":"c1"}'
  const client = new ILinkClient({
    botToken: 'tok',
    fetchImpl: async () => new Response(raw, { status: 200 }),
  })

  const batch = await client.getUpdates()
  assert.equal(batch.msgs[0].message_id, '18446744073709551615')
  assert.equal(batch.getUpdatesBuf, 'c1')
})
