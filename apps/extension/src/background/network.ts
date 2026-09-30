/**
 * CDP Network-domain recorder — the Service-Wide singleton that buffers a
 * tab's network exchanges while a capture is active (started by the
 * `page_network` tool's `action: "start"`).
 *
 * - one buffer per attached tab, capped: oldest exchanges fall out and the
 *   drop counter reports the loss instead of silently truncating;
 * - events are merged by CDP requestId (redirect hops update the entry),
 *   so one logical request stays one line in the readout;
 * - the buffer is engine-lifetime state: a detach or an SW restart drops it,
 *   and the next read reports an empty inactive capture.
 * @module background/network
 */

/** Buffer limits: entries kept per tab, and per-field trims on the wire. */
const MAX_ENTRIES_PER_TAB = 400
const MAX_URL_CHARS = 600
const MAX_POST_DATA_CHARS = 4000

/** One in-progress or finished exchange, keyed by CDP requestId. */
interface RecordedExchange {
  url: string
  method: string
  resourceType: string
  status?: number
  mimeType?: string
  error?: string
  fromCache?: boolean
  postData?: string
  responseBytes?: number
  /** First-sight order, used to keep the readout stable. */
  order: number
}

interface TabRecorder {
  exchanges: Map<string, RecordedExchange>
  dropped: number
  nextOrder: number
  active: boolean
}

/** The seam-facing read shape (packages/browser `NetworkCapture`). */
export interface NetworkCaptureResult {
  exchanges: Array<{
    url: string
    method: string
    resourceType: string
    status?: number
    mimeType?: string
    error?: string
    fromCache?: boolean
    postData?: string
    responseBytes?: number
  }>
  active: boolean
  dropped: number
}

function trim(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  return value.length <= max ? value : value.slice(0, max)
}

/**
 * The recorder: pure state assembly lives in {@link ingest}, exercised by
 * unit tests without a browser; the CDP plumbing rides {@link send}.
 */
export class NetworkRecorder {
  private readonly tabs = new Map<number, TabRecorder>()

  /** Whether a capture is running for the tab. */
  isActive(tabId: number): boolean {
    return this.tabs.get(tabId)?.active === true
  }

  /**
   * Ingest one CDP Network event for the tab. Unknown tabs and inactive
   * captures drop the event on the floor — enabling the Network domain is
   * the only way captures begin.
   * @param tabId - the debugger source tab.
   * @param method - the CDP event method (`Network.*`).
   * @param params - the event payload.
   */
  ingest(tabId: number, method: string, params: Record<string, unknown>): void {
    const recorder = this.tabs.get(tabId)
    if (recorder === undefined || !recorder.active) return
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined
    if (requestId === undefined) return

    if (method === 'Network.requestWillBeSent') {
      const request = params['request'] as { url?: unknown; method?: unknown; postData?: unknown } | undefined
      if (request === undefined || typeof request.url !== 'string') return
      const existing = recorder.exchanges.get(requestId)
      const entry: RecordedExchange = existing ?? {
        url: '', method: 'GET', resourceType: 'Other', order: recorder.nextOrder,
      }
      recorder.nextOrder += 1
      const url = trim(request.url, MAX_URL_CHARS)
      if (url !== undefined) entry.url = url
      if (typeof request.method === 'string') entry.method = request.method
      if (typeof request.postData === 'string' && request.postData !== '') {
        const postData = trim(request.postData, MAX_POST_DATA_CHARS)
        if (postData !== undefined) entry.postData = postData
      }
      // A redirect hop re-uses the requestId with a redirectResponse payload;
      // the newest request line is the one the readout should show.
      if (existing !== undefined) delete entry.status
      recorder.exchanges.set(requestId, entry)
      this.enforceLimit(tabId)
      return
    }

    const entry = recorder.exchanges.get(requestId)
    if (entry === undefined) return

    if (method === 'Network.responseReceived') {
      const response = params['response'] as { status?: unknown; mimeType?: unknown; fromDiskCache?: unknown } | undefined
      if (response !== undefined) {
        if (typeof response.status === 'number') entry.status = response.status
        if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType
        if (response.fromDiskCache === true) entry.fromCache = true
      }
      const resourceType = params['type']
      if (typeof resourceType === 'string' && resourceType !== '') {
        entry.resourceType = resourceType
      }
      return
    }
    if (method === 'Network.loadingFinished') {
      const length = params['encodedDataLength']
      if (typeof length === 'number') entry.responseBytes = Math.round(length)
      return
    }
    if (method === 'Network.loadingFailed') {
      const canceled = params['canceled'] === true
      const errorText = typeof params['errorText'] === 'string' ? params['errorText'] : 'failed'
      entry.error = canceled ? 'canceled' : errorText
    }
    this.enforceLimit(tabId)
  }

  /**
   * Drop all buffered exchanges; keeps the tab known so a stale read returns
   * an empty capture instead of "no capture" confusion.
   */
  reset(tabId: number): void {
    this.tabs.set(tabId, { exchanges: new Map(), dropped: 0, nextOrder: 0, active: true })
  }

  /** Mark the capture inactive (read with stop, or the session detached). */
  stop(tabId: number): void {
    const recorder = this.tabs.get(tabId)
    if (recorder !== undefined) recorder.active = false
  }

  /** Forget the tab entirely (session detached: nothing will arrive anymore). */
  forget(tabId: number): void {
    this.tabs.delete(tabId)
  }

  /**
   * Read the buffered exchanges, optionally filtered. Insertion order (first
   * sight of each request) is preserved; filters are case-insensitive
   * substrings on URL and resource type.
   */
  read(tabId: number, opts: { stop?: boolean; filter?: string; resourceType?: string } = {}): NetworkCaptureResult {
    const recorder = this.tabs.get(tabId)
    const filter = opts.filter?.toLowerCase() ?? ''
    const resourceType = opts.resourceType?.toLowerCase() ?? ''
    const exchanges = (recorder === undefined ? [] : [...recorder.exchanges.values()]
      .sort((a, b) => a.order - b.order)
      .filter(entry => (filter === '' || entry.url.toLowerCase().includes(filter)))
      .filter(entry => (resourceType === '' || entry.resourceType.toLowerCase().includes(resourceType)))
      .map(entry => ({
        url: entry.url,
        method: entry.method,
        resourceType: entry.resourceType,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.fromCache === undefined ? {} : { fromCache: entry.fromCache }),
        ...(entry.postData === undefined ? {} : { postData: entry.postData }),
        ...(entry.responseBytes === undefined ? {} : { responseBytes: entry.responseBytes }),
      })))
    const wasActive = recorder?.active === true
    if (opts.stop === true) {
      this.stop(tabId)
      this.forget(tabId)
    }
    // The result reports the post-action state: a stop read says inactive.
    return {
      exchanges,
      active: opts.stop === true ? false : wasActive,
      dropped: recorder?.dropped ?? 0,
    }
  }

  /** Enforce the per-tab buffer cap after an ingest burst. */
  enforceLimit(tabId: number): void {
    const recorder = this.tabs.get(tabId)
    if (recorder === undefined) return
    while (recorder.exchanges.size > MAX_ENTRIES_PER_TAB) {
      const oldest = [...recorder.exchanges.entries()]
        .sort((a, b) => a[1].order - b[1].order)[0]
      if (oldest === undefined) break
      recorder.exchanges.delete(oldest[0])
      recorder.dropped += 1
    }
  }
}

/** Global singleton: one recorder for the whole Service Worker. */
export const networkRecorder = new NetworkRecorder()
