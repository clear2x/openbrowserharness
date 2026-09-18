/**
 * Inline-SVG icon set for the extension shell (shell header, transcript, and
 * composer chips all draw from one module so the duplication gate sees a
 * single definition per path). Every icon inherits `currentColor`, so
 * light/dark pairing rides the ambient text token.
 */

import type { ReactNode } from 'react'
import type { JSX } from 'react'

function SvgIcon({ children, size = 14 }: { children: ReactNode; size?: number | undefined }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const HistoryIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </SvgIcon>
)

export const ChevronDownIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}><path d="m6 9 6 6 6-6" /></SvgIcon>
)

export const CloseIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></SvgIcon>
)

export const CopyIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </SvgIcon>
)

export const CheckIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}><path d="M20 6 9 17l-5-5" /></SvgIcon>
)

export const RetryIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </SvgIcon>
)

export const ArrowUpIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </SvgIcon>
)

export const GlobeIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </SvgIcon>
)

/** Composer model-badge glyph: a chip (processor) marking "which model". */
export const CpuIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <rect x="5" y="5" width="14" height="14" rx="2" ry="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </SvgIcon>
)

/** Reasoning-effort segment glyph: a lightbulb marking "thinking". */
export const LightbulbIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z" />
  </SvgIcon>
)

/** Context-meter glyph: an arc gauge with a needle marking capacity usage. */
export const GaugeIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M12 21a9 9 0 1 1 9-9" />
    <path d="m16.5 7.5-4 4" />
    <circle cx="12" cy="12" r="1" />
  </SvgIcon>
)

/** User-plugin management glyph: a puzzle piece marking the plugin roster. */
export const PuzzleIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
  </SvgIcon>
)

/** Attachment strip glyph: a paperclip marking "attach an image". */
export const PaperclipIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </SvgIcon>
)

/** Permission-mode glyph: a shield marking the tool-approval posture. */
export const ShieldIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </SvgIcon>
)

/** Example-prompt glyph: a text page marking "summarize this page". */
export const DocIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M8 13h8" />
    <path d="M8 17h8" />
    <path d="M8 9h2" />
  </SvgIcon>
)

/** Example-prompt glyph: a shopping cart marking "compare and buy". */
export const CartIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
  </SvgIcon>
)

/** Rename glyph: a pencil marking inline title editing. */
export const PencilIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </SvgIcon>
)

/** Example-prompt glyph: a play circle marking "video actions". */
export const PlayIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="m10 8 6 4-6 4z" />
  </SvgIcon>
)

/** Menu/disclosure arrow pointing right (hover affordance on example cards). */
export const ChevronRightIcon = ({ size }: { size?: number | undefined }): JSX.Element => (
  <SvgIcon size={size}><path d="m9 18 6-6-6-6" /></SvgIcon>
)
