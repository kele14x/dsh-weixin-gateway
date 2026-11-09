import test from 'node:test'
import assert from 'node:assert/strict'
import { scrub, scrubString } from '../src/util/log.mjs'

test('media query parameters are redacted from log strings', () => {
  const text = scrubString(
    'GET https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=secret-value&x=1 upload_param=other',
  )
  assert.doesNotMatch(text, /secret-value|other/)
  assert.match(text, /encrypted_query_param=\[redacted\]/)
  assert.match(text, /upload_param=\[redacted\]/)
})

test('media secret fields are redacted from structured log values', () => {
  const scrubbed = scrub({
    aeskey: '00112233445566778899aabbccddeeff',
    aes_key: 'c2VjcmV0',
    encrypt_query_param: 'secret',
    upload_param: 'secret',
    full_url: 'https://cdn.example/x?encrypted_query_param=secret',
    bytes: 42,
  })
  assert.equal(scrubbed.aeskey, '[redacted]')
  assert.equal(scrubbed.aes_key, '[redacted]')
  assert.equal(scrubbed.encrypt_query_param, '[redacted]')
  assert.equal(scrubbed.upload_param, '[redacted]')
  assert.equal(scrubbed.full_url, '[redacted]')
  assert.equal(scrubbed.bytes, 42)
})

test('existing token and QR redaction still applies', () => {
  assert.equal(scrubString('Authorization: Bearer abc.def'), 'Authorization: Bearer [redacted]')
  assert.equal(scrubString('qrcode=abc123&x=1'), 'qrcode=[redacted]&x=1')
})
