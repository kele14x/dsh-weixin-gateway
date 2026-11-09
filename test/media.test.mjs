import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  imageAesKey,
  parseAesKey,
} from '../src/media/crypto.mjs'
import {
  MediaDownloader,
  cdnDownloadUrl,
  sniffImageMediaType,
} from '../src/media/download.mjs'
import { MediaError } from '../src/media/errors.mjs'
import { JPEG_BYTES } from './helpers/fake-media.mjs'

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

/**
 * Build a fetch implementation that returns a fixed response.
 *
 * @param {Buffer} bytes - response body.
 * @param {object} [options] - response options.
 * @returns {{fetchImpl: Function, calls: object[]}} fake fetch and its calls.
 */
function fakeFetch(bytes, { status = 200, headers = {}, url = '' } = {}) {
  const calls = []
  const fetchImpl = async (requested, init) => {
    calls.push({ url: requested, init })
    const response = new Response(bytes, { status, headers })
    if (url.length > 0) Object.defineProperty(response, 'url', { value: url })
    return response
  }
  return { fetchImpl, calls }
}

test('parseAesKey accepts raw bytes, hex, and base64-of-hex encodings', () => {
  assert.deepEqual(parseAesKey(KEY), KEY)
  assert.deepEqual(parseAesKey(KEY.toString('hex')), KEY)
  assert.deepEqual(parseAesKey(KEY.toString('base64')), KEY)
  assert.deepEqual(parseAesKey(Buffer.from(KEY.toString('hex')).toString('base64')), KEY)
  assert.throws(() => parseAesKey('not-a-key'), (error) => error.code === 'media/invalid-key')
})

test('imageAesKey prefers the hex aeskey and falls back to media.aes_key', () => {
  assert.deepEqual(imageAesKey({ aeskey: KEY.toString('hex'), media: {} }), KEY)
  assert.deepEqual(imageAesKey({ media: { aes_key: KEY.toString('base64') } }), KEY)
  assert.equal(imageAesKey({ media: {} }), undefined)
  assert.throws(
    () => imageAesKey({ aeskey: 'short', media: {} }),
    (error) => error.code === 'media/invalid-key',
  )
})

test('AES-128-ECB round-trips with PKCS#7 padding', () => {
  const ciphertext = encryptAesEcb(JPEG_BYTES, KEY)
  assert.equal(ciphertext.length, aesEcbPaddedSize(JPEG_BYTES.length))
  assert.deepEqual(decryptAesEcb(ciphertext, KEY), JPEG_BYTES)
  assert.throws(
    () => decryptAesEcb(ciphertext.subarray(0, 15), KEY),
    (error) => error.code === 'media/decrypt',
  )
})

test('cdnDownloadUrl prefers full_url and encodes the fallback query', () => {
  const base = 'https://novac2c.cdn.weixin.qq.com/c2c'
  assert.equal(
    cdnDownloadUrl({ full_url: 'https://cdn.example/x' }, base),
    'https://cdn.example/x',
  )
  assert.equal(
    cdnDownloadUrl({ encrypt_query_param: 'a+b/c=' }, base),
    `${base}/download?encrypted_query_param=${encodeURIComponent('a+b/c=')}`,
  )
  assert.throws(() => cdnDownloadUrl({}, base), (error) => error.code === 'media/no-url')
})

test('sniffImageMediaType recognizes supported magic bytes', () => {
  assert.equal(sniffImageMediaType(JPEG_BYTES), 'image/jpeg')
  assert.equal(
    sniffImageMediaType(Buffer.from('89504e470d0a1a0a00000000', 'hex')),
    'image/png',
  )
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a000000', 'ascii')), 'image/gif')
  assert.equal(
    sniffImageMediaType(Buffer.from('RIFF0000WEBP0000', 'ascii')),
    'image/webp',
  )
  assert.equal(sniffImageMediaType(Buffer.from('not an image at all', 'ascii')), undefined)
})

test('downloadImage decrypts an aeskey-protected image', async () => {
  const ciphertext = encryptAesEcb(JPEG_BYTES, KEY)
  const { fetchImpl, calls } = fakeFetch(ciphertext)
  const downloader = new MediaDownloader({ fetchImpl })
  const image = {
    aeskey: KEY.toString('hex'),
    media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1' },
  }

  const result = await downloader.downloadImage(image)
  assert.equal(result.mediaType, 'image/jpeg')
  assert.deepEqual(result.data, JPEG_BYTES)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, image.media.full_url)
  assert.equal(calls[0].init.headers.authorization, undefined)
})

test('downloadImage accepts a plaintext image without a key', async () => {
  const { fetchImpl, calls } = fakeFetch(JPEG_BYTES)
  const downloader = new MediaDownloader({ fetchImpl })
  const result = await downloader.downloadImage({
    media: { encrypt_query_param: 'param' },
  })

  assert.deepEqual(result.data, JPEG_BYTES)
  assert.match(calls[0].url, /\/download\?encrypted_query_param=param$/)
})

test('downloadImage rejects an image over the byte cap', async () => {
  const { fetchImpl } = fakeFetch(Buffer.alloc(64), {
    headers: { 'content-length': '64' },
  })
  const downloader = new MediaDownloader({ fetchImpl, maxImageBytes: 32 })
  await assert.rejects(
    downloader.downloadImage({ media: { full_url: 'https://novac2c.cdn.weixin.qq.com/x' } }),
    (error) => error.code === 'media/too-large' && error.maxBytes === 32,
  )
})

test('downloadImage rejects an image over the byte cap while streaming', async () => {
  const fetchImpl = async () => {
    const response = new Response(Buffer.alloc(64), { status: 200 })
    response.headers.delete('content-length')
    return response
  }
  const downloader = new MediaDownloader({ fetchImpl, maxImageBytes: 32 })
  await assert.rejects(
    downloader.downloadImage({ media: { full_url: 'https://novac2c.cdn.weixin.qq.com/x' } }),
    (error) => error.code === 'media/too-large' && error.maxBytes === 32,
  )
})

test('downloadImage rejects a non-image payload', async () => {
  const { fetchImpl } = fakeFetch(Buffer.from('this is not an image payload', 'ascii'))
  const downloader = new MediaDownloader({ fetchImpl })
  await assert.rejects(
    downloader.downloadImage({ media: { full_url: 'https://novac2c.cdn.weixin.qq.com/x' } }),
    (error) => error.code === 'media/unsupported-type',
  )
})

test('downloadImage refuses a full_url on an untrusted host', async () => {
  const { fetchImpl } = fakeFetch(JPEG_BYTES)
  const downloader = new MediaDownloader({ fetchImpl })
  await assert.rejects(
    downloader.downloadImage({ media: { full_url: 'https://evil.example/image.jpg' } }),
    (error) => error.code === 'media/blocked-host',
  )
})

test('downloadImage refuses plain HTTP unless tests opt in', async () => {
  const { fetchImpl } = fakeFetch(JPEG_BYTES)
  const downloader = new MediaDownloader({ fetchImpl })
  await assert.rejects(
    downloader.downloadImage({ media: { full_url: 'http://novac2c.cdn.weixin.qq.com/x' } }),
    (error) => error.code === 'media/blocked-url',
  )
  const insecure = new MediaDownloader({ fetchImpl, allowHttp: true })
  const result = await insecure.downloadImage({
    media: { full_url: 'http://novac2c.cdn.weixin.qq.com/x' },
  })
  assert.equal(result.mediaType, 'image/jpeg')
})

test('MediaError carries a stable code and no URL', () => {
  const error = new MediaError('media/http', 'media download answered HTTP 404', { status: 404 })
  assert.equal(error.name, 'MediaError')
  assert.equal(error.code, 'media/http')
  assert.equal(error.status, 404)
  assert.doesNotMatch(error.message, /https?:/)
})
