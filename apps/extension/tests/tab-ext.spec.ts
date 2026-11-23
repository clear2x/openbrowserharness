/**
 * background/tab-ext: the chrome tab → TabInfo projection. A tab that is
 * still navigating to its first document reports an empty `url` with the
 * destination in `pendingUrl` — the real-session log showed `tabs_open`
 * rendering「已打开标签页 N：」with nothing after the colon, and every
 * URL-based tab match (the video lane's /video/BV pick) missing such tabs.
 * @module @deepseek-ai/dsh-extension/tests/tab-ext
 */
import { describe, expect, it } from 'vitest'
import { toTabInfo } from '../src/background/tab-ext.ts'

/** A minimal chrome.tabs.Tab with the fields the projection reads. */
function tab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    id: 42,
    index: 1,
    windowId: 3,
    pinned: false,
    highlighted: false,
    active: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    ...overrides,
  } as chrome.tabs.Tab
}

describe('toTabInfo', () => {
  it('reports the pending destination while the first navigation has not committed', () => {
    const info = toTabInfo(tab({ url: '', pendingUrl: 'https://www.bilibili.com/video/BV1/' }))
    expect(info).toMatchObject({ tabId: 42, windowId: 3, index: 1, url: 'https://www.bilibili.com/video/BV1/' })
  })

  it('reports the committed URL once the tab has one, even when another navigation is pending', () => {
    const info = toTabInfo(tab({ url: 'https://a.example/', pendingUrl: 'https://b.example/' }))
    expect(info.url).toBe('https://a.example/')
  })

  it('falls back to an empty URL when neither field is set and projects the mute/pin state', () => {
    const info = toTabInfo(tab({ pinned: true, mutedInfo: { muted: true }, active: true }))
    expect(info).toMatchObject({ url: '', pinned: true, muted: true, active: true })
  })
})
