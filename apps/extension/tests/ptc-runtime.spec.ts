/**
 * chrome-ptc-runtime spec: the two pure layers of the browser PTC runtime —
 * the Service Definition contract checks in `resolve()` (argument validation,
 * budget defaulting and capping), and the sandbox program runner's real
 * execution path driven in-process with a captured postMessage pipe (async
 * program, binding round-trip, console capture, and the failure shapes).
 */

import { afterEach, describe, expect, it } from 'vitest'

/** Install a minimal window double whose parent.postMessage is captured. */
function capturePosts(): { posts: Array<Record<string, unknown>>; restore(): void } {
  const posts: Array<Record<string, unknown>> = []
  const globalWindow = globalThis as { window?: unknown }
  const previous = globalWindow.window
  globalWindow.window = {
    parent: {
      postMessage: (message: unknown): void => {
        posts.push(message as Record<string, unknown>)
      },
    },
    location: { ancestorOrigins: [] as string[] },
  }
  return {
    posts,
    restore: (): void => {
      globalWindow.window = previous
    },
  }
}

describe('chrome-ptc-runtime resolve', () => {
  it('defaults the budget, caps oversized ones, and passes null through', async () => {
    const mod = await import('../src/chrome/ptc-runtime-sandbox.ts')
    const runtime = Object.create(mod.default.prototype) as InstanceType<typeof mod.default>
    // Private-field seeding via direct assignment (constructor needs chrome/DOM).
    ;(runtime as unknown as Record<string, unknown>).defaultTimeoutMs = 120_000
    ;(runtime as unknown as Record<string, unknown>).maxTimeoutMs = 300_000
    expect(runtime.resolve({ program: 'return 1', bindings: [] }).timeoutMs).toBe(120_000)
    expect(runtime.resolve({ program: 'return 1', bindings: [], timeoutMs: 5000 }).timeoutMs).toBe(5000)
    expect(runtime.resolve({ program: 'return 1', bindings: [], timeoutMs: 999_999 }).timeoutMs).toBe(300_000)
    expect(runtime.resolve({ program: 'return 1', bindings: [], timeoutMs: null }).timeoutMs).toBe(null)
    expect(runtime.resolve({ program: 'return 1', bindings: [], cwd: 'skills' }).cwd).toBe('skills')
    expect(runtime.resolve({ program: 'return 1', bindings: [] }).cwd).toBe('/')
    expect(() => runtime.resolve({ program: '', bindings: [] })).toThrow()
    expect(() => runtime.resolve({ program: 'x', bindings: [], timeoutMs: -1 })).toThrow()
  })
})

describe('program-runner', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('runs an async program with a binding round-trip and console capture', async () => {
    const capture = capturePosts()
    const { handleProgram, handleBindingResult } = await import('../src/sandbox/program-runner.ts')
    handleProgram({
      id: 'p1',
      program: [
        'const doubled = await tools.double(21)',
        'console.log("doubled:", doubled)',
        'return doubled + 1',
      ].join('\n'),
      bindings: [{ global: 'tools', functions: ['double'] }],
    })
    // The program parks on its first binding call.
    const call = capture.posts.find(post => post.type === 'binding-call') as
      | { id: string; callId: string; ns: string; fn: string; args: unknown[] }
      | undefined
    expect(call, 'binding-call posted').toBeDefined()
    expect(call?.ns).toBe('tools')
    expect(call?.fn).toBe('double')
    expect(call?.args[0]).toBe(21)
    handleBindingResult({ id: call?.id, callId: call?.callId, ok: true, value: 42 })
    // The console line and the completion both ride the captured posts.
    await new Promise(resolve => setTimeout(resolve, 20))
    const consolePost = capture.posts.find(post => post.type === 'program-console') as
      | { level: string; parts: unknown[] }
      | undefined
    expect(consolePost?.parts.join(' ')).toContain('doubled: 42')
    const completion = capture.posts.find(post => post.id === 'p1' && post.ok === true) as { value: number } | undefined
    expect(completion?.value).toBe(43)
    capture.restore()
  })

  it('reports a rejected binding through the declared error class', async () => {
    const capture = capturePosts()
    const { handleProgram, handleBindingResult } = await import('../src/sandbox/program-runner.ts')
    handleProgram({
      id: 'p2',
      program: 'try { await tools.fail("boom") } catch (err) { return err.toolName }',
      bindings: [{ global: 'tools', functions: ['fail'], errorClass: { name: 'ToolError', memberNameProperty: 'toolName' } }],
    })
    const call = capture.posts.find(post => post.type === 'binding-call') as { id: string; callId: string } | undefined
    expect(call).toBeDefined()
    handleBindingResult({ id: call?.id, callId: call?.callId, ok: false, error: 'boom' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const completion = capture.posts.find(post => post.id === 'p2' && post.ok === true) as { value: string } | undefined
    expect(completion?.value).toBe('boom')
    capture.restore()
  })

  it('fails the run when the completion cannot cross the boundary', async () => {
    const capture = capturePosts()
    const { handleProgram } = await import('../src/sandbox/program-runner.ts')
    handleProgram({ id: 'p3', program: 'return () => 1', bindings: [] })
    await new Promise(resolve => setTimeout(resolve, 20))
    const failure = capture.posts.find(post => post.id === 'p3' && post.ok === false) as { error: string } | undefined
    expect(failure?.error).toContain('not transferable')
    capture.restore()
  })
})
