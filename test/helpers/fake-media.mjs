/**
 * Fake inbound media downloader for gateway tests.
 *
 * @module test/helpers/fake-media
 */

/** Small byte sequence with a JPEG magic prefix. */
export const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
])

/** In-memory media downloader stand-in. */
export class FakeMedia {
  /**
   * @param {object} [options] - fake options.
   * @param {Array<{data: Buffer, mediaType: string}>} [options.images] - queued results.
   * @param {Error} [options.failWith] - failure raised by every download.
   */
  constructor({ images = [], failWith } = {}) {
    this.images = [...images]
    this.failWith = failWith
    this.calls = []
  }

  /**
   * Record and resolve one image download.
   *
   * @param {object} item - `image_item`.
   * @param {{signal?: AbortSignal}} [options] - download options.
   * @returns {Promise<{data: Buffer, mediaType: string}>} image bytes.
   */
  async downloadImage(item, { signal } = {}) {
    this.calls.push(item)
    if (signal?.aborted) {
      const error = new Error('media download was cancelled')
      error.code = 'media/aborted'
      throw error
    }
    if (this.failWith !== undefined) throw this.failWith
    return this.images.shift() ?? { data: JPEG_BYTES, mediaType: 'image/jpeg' }
  }
}
