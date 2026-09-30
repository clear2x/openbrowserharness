// @vitest-environment jsdom
/**
 * Network-recorder spec: the pure state assembly behind the `page_network`
 * tool's Service-Worker recorder — event merging by requestId (redirect hops
 * stay one entry), filter semantics, stop/forget lifecycle, and the per-tab
 * buffer cap with its drop counter.
 * @module @deepseek-ai/dsh-extension/tests/network-recorder
 */

import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '../src/background/network.ts'

describe('NetworkRecorder', () => {
  it('ignores events for tabs without an active capture', () => {
    const recorder = new NetworkRecorder()
    recorder.ingest(1, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x/api', method: 'GET' },
    })
    expect(recorder.read(1)).toEqual({ exchanges: [], active: false, dropped: 0 })
  })

  it('merges the request/response/finished lifecycle into one exchange', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x/api/list?page=2', method: 'POST', postData: '{"kw":"a"}' },
    })
    recorder.ingest(7, 'Network.responseReceived', {
      requestId: 'r1',
      type: 'XHR',
      response: { status: 200, mimeType: 'application/json' },
    })
    recorder.ingest(7, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1523.7 })
    const capture = recorder.read(7)
    expect(capture.active).toBe(true)
    expect(capture.exchanges).toEqual([{
      url: 'https://x/api/list?page=2',
      method: 'POST',
      resourceType: 'XHR',
      status: 200,
      mimeType: 'application/json',
      postData: '{"kw":"a"}',
      responseBytes: 1524,
    }])
  })

  it('keeps one entry across a redirect hop and drops the stale status', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x/old', method: 'GET' },
    })
    recorder.ingest(7, 'Network.responseReceived', { requestId: 'r1', type: 'Document', response: { status: 302 } })
    recorder.ingest(7, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://x/new', method: 'GET' },
      redirectResponse: { status: 302 },
    })
    recorder.ingest(7, 'Network.responseReceived', { requestId: 'r1', type: 'Document', response: { status: 200 } })
    const [entry] = recorder.read(7).exchanges
    expect(entry).toMatchObject({ url: 'https://x/new', status: 200 })
  })

  it('filters by case-insensitive url and resource-type substrings without mutating the buffer', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://x/API/list', method: 'GET' } })
    recorder.ingest(7, 'Network.responseReceived', { requestId: 'a', type: 'XHR', response: { status: 200 } })
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'b', request: { url: 'https://cdn.x/img.png', method: 'GET' } })
    recorder.ingest(7, 'Network.responseReceived', { requestId: 'b', type: 'Image', response: { status: 200 } })

    const filtered = recorder.read(7, { filter: 'api' })
    expect(filtered.exchanges).toHaveLength(1)
    expect(filtered.exchanges[0]?.url).toBe('https://x/API/list')

    const byType = recorder.read(7, { resourceType: 'xhr' })
    expect(byType.exchanges).toHaveLength(1)
    expect(byType.exchanges[0]?.resourceType).toBe('XHR')

    expect(recorder.read(7).exchanges).toHaveLength(2)
  })

  it('records failures and cancellation from loadingFailed', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'e', request: { url: 'https://x/dead', method: 'GET' } })
    recorder.ingest(7, 'Network.loadingFailed', { requestId: 'e', errorText: 'net::ERR_CONNECTION_RESET' })
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'c', request: { url: 'https://x/slow', method: 'GET' } })
    recorder.ingest(7, 'Network.loadingFailed', { requestId: 'c', canceled: true })
    const capture = recorder.read(7)
    expect(capture.exchanges[0]).toMatchObject({ url: 'https://x/dead', error: 'net::ERR_CONNECTION_RESET' })
    expect(capture.exchanges[1]).toMatchObject({ url: 'https://x/slow', error: 'canceled' })
  })

  it('stop+forget ends the capture and clears the buffer', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://x/a', method: 'GET' } })
    const capture = recorder.read(7, { stop: true })
    expect(capture.active).toBe(true)
    expect(capture.exchanges).toHaveLength(1)
    expect(recorder.isActive(7)).toBe(false)
    expect(recorder.read(7)).toEqual({ exchanges: [], active: false, dropped: 0 })
  })

  it('evicts the oldest exchanges past the buffer cap and counts the drops', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    for (let index = 0; index < 405; index += 1) {
      recorder.ingest(7, 'Network.requestWillBeSent', {
        requestId: `r${index}`,
        request: { url: `https://x/r/${index}`, method: 'GET' },
      })
    }
    const capture = recorder.read(7)
    expect(capture.exchanges).toHaveLength(400)
    expect(capture.dropped).toBe(5)
    expect(capture.exchanges[0]?.url).toBe('https://x/r/5')
    expect(capture.exchanges.at(-1)?.url).toBe('https://x/r/404')
  })

  it('a fresh start clears the previous buffer', () => {
    const recorder = new NetworkRecorder()
    recorder.reset(7)
    recorder.ingest(7, 'Network.requestWillBeSent', { requestId: 'a', request: { url: 'https://x/old', method: 'GET' } })
    recorder.reset(7)
    expect(recorder.read(7)).toEqual({ exchanges: [], active: true, dropped: 0 })
  })
})
