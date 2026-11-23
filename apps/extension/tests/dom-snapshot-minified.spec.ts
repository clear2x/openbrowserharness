/**
 * The minified-injection regression locks (批279/280): the page_* tool suite
 * assembles in-page expressions from `fn.toString()` of module helpers. A
 * development build keeps original names so cross-helper calls resolve; a
 * MINIFIED build renames the module scope (G, $, …) while a template that
 * binds the ORIGINAL name leaves every cross-helper call inside the
 * serialized bodies pointing at a name the page never had —
 * 「G is not defined」 on every real page (real-machine probe catch, batch
 * 279). Two locks keep the class closed:
 *
 * 1. Leak scan — every expression is re-assembled from an esbuild-minified
 *    bundle (the exact production transform) and walked with the TypeScript
 *    compiler API: any identifier reference that is neither a local binding,
 *    a parameter, a property position, a keyword, nor a known page global
 *    fails here instead of on a user's page.
 * 2. Structural rule — no source template may bind a serialized function
 *    under a literal identifier; the binding must go through `fn.name` (or
 *    the function must be invoked immediately / passed as an argument).
 * @module @deepseek-ai/dsh-extension/tests/dom-snapshot-minified
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..', '..')
const SOURCE_ROOT = join(__dirname, '..', 'src')

/** The slice of esbuild's JS API this lock uses. */
interface EsbuildApi {
  buildSync(options: {
    entryPoints: string[]
    bundle: boolean
    minify: boolean
    format: 'esm'
    outfile: string
  }): unknown
}

/**
 * esbuild as the extension's own bundler (vite) resolves it. esbuild is not
 * a dependency of this package: neither a bare import nor a
 * `node_modules/.bin` path is guaranteed (a fresh CI install has no root bin).
 */
const esbuild = createRequire(
  realpathSync(createRequire(join(__dirname, 'dom-snapshot-minified.spec.ts')).resolve('vite/package.json')),
)('esbuild') as EsbuildApi

interface ExpressionSet {
  snap: string
  resolve: string
  probe: string
  wait: string
  prep: string
  readback: string
  clear: string
  find: string
  batchTarget: string
}

/** Bundle the entry minified (production shape) and run it to print the expressions. */
function buildMinifiedExpressions(): ExpressionSet {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-minified-expr-'))
  const bundlePath = join(outDir, 'entry.mjs')
  // esbuild bundles the entry minified — the production build's exact
  // transform — and plain node runs it to print the assembled expressions.
  esbuild.buildSync({
    entryPoints: [join(__dirname, 'minified-expressions-entry.ts')],
    bundle: true,
    minify: true,
    format: 'esm',
    outfile: bundlePath,
  })
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
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame',
  'Event', 'InputEvent', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
])

/**
 * Every identifier reference of one expression that is NOT a property
 * position (`x.y`'s `y`), an object-literal key, or a method name.
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
 * Every name the expression binds: variable declarations (chains
 * included), function declarations and named function expressions, class
 * declarations, parameters, catch clauses.
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
        || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
        || ts.isClassExpression(node) || ts.isCatchClause(node))
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
 * keyword, not a page global. The serialized helpers must reference ONLY
 * their page bindings and DOM globals — anything else is a module-scope
 * leak (the production G-is-not-defined).
 * @param code - the assembled in-page expression.
 * @returns the leaked identifiers.
 */
function leakedIdentifiers(code: string): string[] {
  const bound = boundNames(code)
  return [...identifierReferences(code)].filter(
    id => !bound.has(id) && !NON_IDENTIFIERS.has(id) && !PAGE_GLOBALS.has(id),
  )
}

/** Template text ending in a literal `var|let|const NAME =` declaration head. */
const LITERAL_BINDING_HEAD = /(?:^|[^\w$.])(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*$/u

/** A template span expression that is a bare function serialization (`helper.toString()`). */
const SERIALIZED_FUNCTION = /^[A-Za-z_$][\w$]*\.toString\(\)$/u

/** Every TypeScript source file under one directory, recursively. */
function sourceFilesUnder(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path))
    else if (/\.tsx?$/u.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * The structural violations of one source text: template spans that bind a
 * serialized function under a literal identifier
 * (`var helper = ${helper.toString()}`) — the pattern whose minified body
 * then calls helper names the page never received.
 * @param text - the TypeScript source.
 * @param fileName - the path reported in each violation.
 * @returns `file:line (expression)` locations.
 */
function literalBoundSerializationsIn(text: string, fileName: string): string[] {
  const violations: string[] = []
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span, index) => {
        const expression = span.expression.getText(source)
        if (!SERIALIZED_FUNCTION.test(expression)) return
        const preceding = index === 0 ? node.head.text : node.templateSpans[index - 1]?.literal.text ?? ''
        if (LITERAL_BINDING_HEAD.test(preceding)) {
          const { line } = source.getLineAndCharacterOfPosition(span.getStart(source))
          violations.push(`${fileName}:${String(line + 1)} (${expression})`)
        }
      })
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return violations
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

  it.each([
    ['snapshot walk', 'snap'],
    ['element re-resolve', 'resolve'],
    ['click probe', 'probe'],
    ['wait poll', 'wait'],
    ['snapshot pre-step sweep', 'prep'],
    ['typed-value readback', 'readback'],
    ['typed-value clear', 'clear'],
    ['page_find_related collector', 'find'],
    ['page_batch_actions target probe', 'batchTarget'],
  ] as const)('%s leaks no module-scope identifier', (_label, key) => {
    expect(leakedIdentifiers(expressions[key])).toEqual([])
  })
})

describe('page-expression authoring rule', () => {
  it('no template binds a serialized function under a literal identifier', () => {
    // Bind through `fn.name` (bind and call sites agree under the minifier),
    // invoke the serialized function immediately, or pass it as an argument.
    const violations = sourceFilesUnder(SOURCE_ROOT).flatMap(file =>
      literalBoundSerializationsIn(readFileSync(file, 'utf8'), file))
    expect(violations).toEqual([])
  })

  it('the rule itself catches the hazardous pattern and passes the safe idioms', () => {
    const hazardous = 'const t = `(() => { var helper = ${helper.toString()}; return helper(1); })()`'
    expect(literalBoundSerializationsIn(hazardous, 'a.ts')).toEqual(['a.ts:1 (helper.toString())'])

    const throughName = 'const t = `(() => { var ${helper.name} = ${helper.toString()}; return ${helper.name}(1); })()`'
    const immediate = 'const t = `(${deepQuery.toString()})(document, "x")`'
    const asArgument = 'const t = `(${run.toString()})("x", ${deepQuery.toString()})`'
    for (const safe of [throughName, immediate, asArgument]) {
      expect(literalBoundSerializationsIn(safe, 'b.ts')).toEqual([])
    }
  })
})
