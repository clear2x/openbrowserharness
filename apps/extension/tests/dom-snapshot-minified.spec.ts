// @vitest-environment jsdom
/**
 * The minified-injection regression lock (批279): the page_* tool suite
 * assembles in-page expressions from `fn.toString()` of module helpers. A
 * development build keeps original names so cross-helper calls resolve; a
 * MINIFIED build renames the module scope (G, $, …) while the template
 * binds the ORIGINAL names — every cross-helper call then throws
 * 「G is not defined」 on the user's page (real-machine probe catch, batch
 * 279). The templates now bind and call through `fn.name`, and THIS spec
 * re-assembles every expression from an esbuild-minified bundle — the
 * production failure mode — then walks the parsed expressions with the
 * TypeScript compiler API and fails on ANY identifier reference that is
 * neither a local declaration, a parameter/property position, a keyword,
 * nor a known page global. A leaked module-scope name fails here instead
 * of on a user's page.
 * @module @deepseek-ai/dsh-extension/tests/dom-snapshot-minified
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..', '..')

interface ExpressionSet {
  snap: string
  resolve: string
  probe: string
  wait: string
}

/** Bundle the entry minified (production shape) and run it to print the expressions. */
function buildMinifiedExpressions(): ExpressionSet {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-minified-expr-'))
  const bundlePath = join(outDir, 'entry.mjs')
  // Literal command + cwd anchor (the repo's sanctioned exec shape): esbuild
  // bundles the entry minified — the production build's exact transform —
  // and plain node runs it to print the assembled expressions.
  execFileSync('node_modules/.bin/esbuild', [
    '--bundle', '--minify', '--format=esm',
    join(__dirname, 'minified-expressions-entry.ts'),
    '--outfile=' + bundlePath,
  ], { cwd: REPO, stdio: 'pipe' })
  const printed = execFileSync('node', [bundlePath], { cwd: REPO, encoding: 'utf8' })
  return JSON.parse(printed.trim().split(/\r?\n/).at(-1) ?? '{}') as ExpressionSet
}

/** Tokens that are keywords or literals, never identifiers to resolve. */
const NON_IDENTIFIERS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'delete', 'typeof', 'void', 'in', 'of', 'instanceof', 'this', 'try',
  'catch', 'finally', 'throw', 'null', 'true', 'false', 'async', 'await',
])

/** Page globals the expressions legitimately reference. */
const PAGE_GLOBALS = new Set([
  'document', 'window', 'location', 'navigator', 'globalThis',
  'Map', 'Set', 'JSON', 'Math', 'Date', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'parseInt', 'parseFloat', 'isNaN', 'undefined', 'Infinity', 'NaN', 'CSS', 'getComputedStyle',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
])

/**
 * Every identifier reference of one expression that is NOT a property
 * position (`x.y`'s `y`), NOT an object-literal key, and NOT itself a
 * declaration name.
 * @param code - the assembled in-page expression.
 * @returns referenced identifier names.
 */
function identifierReferences(code: string): Set<string> {
  const source = ts.createSourceFile('expr.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const refs = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined
      if (parent === undefined) return
      const isPropertyPosition =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node
        || ts.isEnumMember(parent) && parent.name === node
        || ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isQualifiedName(parent) && parent.right === node
      if (!isPropertyPosition) refs.add(node.text)
      return
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return refs
}

/**
 * Every name the expression binds: variable declarations (chains included),
 * function declarations, parameters, catch clauses, object shorthand.
 * @param code - the assembled in-page expression.
 * @returns bound identifier names.
 */
function boundNames(code: string): Set<string> {
  const source = ts.createSourceFile('expr.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const bound = new Set<string>()
  const visit = (node: ts.Node): void => {
    const name = (node as { name?: ts.Node }).name
    if (
      name !== undefined
      && (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
        || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isCatchClause(node))
      && ts.isIdentifier(name)
    ) {
      bound.add(name.text)
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return bound
}

/**
 * The free identifiers of one expression: referenced but never bound, not a
 * keyword, not a page global. The minified helpers must reference ONLY
 * their page bindings and DOM globals — anything else is a module-scope
 * leak (the production G-is-not-defined).
 * @param code - the assembled in-page expression.
 * @returns the leaked identifiers.
 */
function leakedIdentifiers(code: string): string[] {
  const leaked = [...identifierReferences(code)].filter(
    id => !boundNames(code).has(id) && !NON_IDENTIFIERS.has(id) && !PAGE_GLOBALS.has(id),
  )
  return leaked
}

describe('minified page expressions (the G-is-not-defined lock)', () => {
  const expressions = buildMinifiedExpressions()

  it('assembled the snapshot expression from renamed helpers', () => {
    // The lock only bites when the bundle actually renamed the helpers: a
    // binding must exist whose page-local name is NOT the authored one.
    const bound = [...expressions.snap.matchAll(/var ([A-Za-z_$][\w$]*) = function/g)].map(match => match[1])
    expect(bound.length).toBeGreaterThanOrEqual(5)
    expect(bound).not.toContain('textLeafOk')
  })

  it('snapshot expression leaks nothing', () => {
    expect(leakedIdentifiers(expressions.snap)).toEqual([])
  })

  it('resolve expression leaks nothing', () => {
    expect(leakedIdentifiers(expressions.resolve)).toEqual([])
  })

  it('click probe leaks nothing', () => {
    expect(leakedIdentifiers(expressions.probe)).toEqual([])
  })

  it('wait poll leaks nothing', () => {
    expect(leakedIdentifiers(expressions.wait)).toEqual([])
  })
})
