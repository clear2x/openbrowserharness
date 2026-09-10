/**
 * SidePanel entry: boot the REAL dsh web UI (`sidepanel-dsh/boot.ts`) into
 * #root. The old hand-rolled panel (./App.tsx and friends) stays on disk,
 * unreferenced. No StrictMode — the web shell's `__ModuleLoader__` sink is a
 * page singleton and a double-invoked effect would double-boot.
 */
import '../shims/globals.ts'
import { AGENT_CHANNEL } from '../shared/protocol'
import { bootSidePanel } from '../sidepanel-dsh/boot.ts'

const root = document.getElementById('root')
if (root === null) throw new Error('sidepanel: missing #root')
void bootSidePanel(root)

// Report the host window so the background docks every operated tab beside
// this panel (rightmost slot, left of the panel). Re-sent on every panel
// load, so reopening the panel in another window retargets the dock.
void chrome.windows.getCurrent()
  .then((win) => {
    if (win.id === undefined) return undefined
    return chrome.runtime.sendMessage({
      channel: AGENT_CHANNEL,
      type: 'panel-window',
      windowId: win.id,
    })
  })
  .catch(() => {
    // No receiver yet (SW cold-start race) — a later panel reload re-reports.
  })
