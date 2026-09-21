/**
 * Shared popover plumbing: the dismissal hook plus the stylesheet both
 * floating surfaces (header SessionMenu, composer model/context menus) mount
 * through. One class family (`dshx-pop`) guarantees the same offset, radius,
 * shadow, and the 120 ms open animation across callers; the anchor element is
 * caller-owned (`position:relative` wrapper via `.dshx-menuwrap`).
 *
 * Direction matters inside a full-height panel column: menus hanging from the
 * HEADER open DOWNWARD (`dshx-pop--down`, translateY(-4px) entrance); menus
 * hanging off the bottom COMPOSER would clip against the viewport floor, so
 * they open UPWARD (`dshx-pop--up`). Composer chips sit on the panel's LEFT
 * edge, where a right-aligned surface would spill off-screen — they add
 * `dshx-pop--left` to anchor leftward instead. Width caps at the viewport
 * minus gutters so neither surface can overflow on narrow panels.
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * While `open`, dismiss on any outside pointerdown or on Escape (capture
 * phase, so panel-level shortcuts cannot eat the dismissal).
 *
 * @param open   whether the popover is mounted
 * @param close  setState(false)-style closer
 * @param ref    the anchor wrapper; clicks inside never dismiss
 */
export function usePopoverDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, close, ref])
}

/** Popover surface styles — the single home for the floating-layer look. */
export const POPOVER_CSS = `
.dshx-menuwrap{position:relative;flex:none}
.dshx-pop{position:absolute;right:0;z-index:45;width:min(300px,calc(100vw - 16px));max-height:min(360px,60vh);overflow-y:auto;margin:0;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 12px 32px rgba(0,0,0,.16)}
.dshx-pop--left{left:0;right:auto}
.dshx-pop--down{top:34px;animation:dshx-pop-in-down .12s ease-out}
.dshx-pop--up{bottom:32px;animation:dshx-pop-in-up .12s ease-out}
@keyframes dshx-pop-in-down{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes dshx-pop-in-up{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dshx-pop--down,.dshx-pop--up{animation:none}}
/* shared list rows inside either direction of popover */
.dshx-menuhead{padding:8px 8px 4px;font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-caption,#999)}
.dshx-menuitem{display:flex;align-items:center;gap:8px;width:100%;padding:8px;border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:13px;transition:background .15s ease}
.dshx-menuitem:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-menuitem.is-current{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.dshx-menuitem-check{flex:none;color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-menuitem-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-menuitem.is-current .dshx-menuitem-name{font-weight:600}
.dshx-menuitem-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-menuitem-rename{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#aaa);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease}
.dshx-menuitem:hover .dshx-menuitem-rename,.dshx-menuitem-rename:focus-visible{opacity:1}
.dshx-menuitem-rename:hover{color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-menuitem-delete{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#aaa);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease}
.dshx-menuitem:hover .dshx-menuitem-delete,.dshx-menuitem-delete:focus-visible,.dshx-menuitem-delete.is-armed{opacity:1}
.dshx-menuitem-delete:hover{color:var(--dsw-alias-danger,#e5484d)}
.dshx-menuitem-delete.is-armed{color:var(--dsw-alias-danger,#e5484d)}
.dshx-menuitem.is-rename{display:flex;align-items:center;gap:6px}
.dshx-rename-input{flex:1 1 auto;min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-brand-primary,#4c7dfd);border-radius:6px;background:transparent;color:inherit;font-size:13px}
.dshx-rename-input:focus{outline:none}
.dshx-menuempty{padding:16px 8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
`
