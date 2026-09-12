// @vitest-environment jsdom
/**
 * Capability-panel occupancy probe regression (the extension SidePanel white
 * screen): useCapabilityOccupied extracts the erased-string subscribe face
 * off `ctx.slots` and free-calls it per seat. `ctx.slots` is a cordis
 * traceable proxy whose method faces rebind `this` only when invoked as a
 * method, so the extracted face must be bound before the free call — an
 * unbound call reaches SlotRegistry.subscribe with no receiver, the body's
 * `this._core.subscribe` read throws, and the throw during React effect
 * commit takes the whole shell down through the root slot error boundary.
 * Pins both halves: the unbound pattern still throws against a real
 * ctx.slots (the tripwire that catches a revert), and the hook's bound form
 * subscribes and tracks seat occupancy live.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useCapabilityOccupied } from '../src/sidepanel-dsh/extension-shell.tsx'

afterEach(cleanup)

/** Probe seat; ui-conversation declares the real key in its own compile boundary. */
const SEAT = 'conversation.input.dock'

/** Root context with a real SlotRegistry, viewed as the shell's client face. */
function makeCtx(): ClientContext {
  const raw = new Context()
  new SlotRegistry(raw)
  return raw as unknown as ClientContext
}

/**
 * Erased-string view of the register face (this program's SlotMap lacks the
 * probe keys). Bound for the same receiver rule as the hook's subscribe face.
 */
function registerErased(ctx: ClientContext): (options: Record<string, unknown>, component: unknown) => () => void {
  return (ctx.slots.register as unknown as
    (this: unknown, options: Record<string, unknown>, component: unknown) => () => void)
    .bind(ctx.slots)
}

function OccupancyProbe({ ctx }: { ctx: ClientContext }) {
  const occupied = useCapabilityOccupied(ctx)
  return createElement('div', null, occupied ? 'caps-occupied' : 'caps-empty')
}

describe('useCapabilityOccupied', () => {
  it('keeps the unbound extraction crash documented (a free call loses the traceable receiver)', () => {
    const ctx = makeCtx()
    // Method form keeps its receiver — what read()/snapshot() use.
    expect(Array.isArray(ctx.slots.snapshot('root'))).toBe(true)
    const subscribe = ctx.slots.subscribe as unknown as (key: string, fn: () => void) => () => void
    expect(() => subscribe(SEAT, () => {})).toThrow(TypeError)
  })

  it('tracks seat occupancy through the bound subscribe face', async () => {
    const ctx = makeCtx()
    // Declare the seat the way extension-shell.apply does: an entry in the
    // seeded 'root' hole owns the children table (the roster's real
    // declaration lives in ui-conversation's boundary).
    const disposeDeclaration = registerErased(ctx)({
      name: 'root',
      children: { [SEAT]: { kind: 'single', scope: 'root' } },
    }, () => null)
    const { container } = render(createElement(OccupancyProbe, { ctx }))
    expect(container.textContent).toBe('caps-empty')

    const disposeOccupant = registerErased(ctx)({ name: SEAT }, () => null)
    await waitFor(() => expect(container.textContent).toBe('caps-occupied'))

    disposeOccupant()
    await waitFor(() => expect(container.textContent).toBe('caps-empty'))
    disposeDeclaration()
  })
})
