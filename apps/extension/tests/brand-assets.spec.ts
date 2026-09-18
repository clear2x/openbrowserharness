import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(extensionRoot, '..', '..')
const publicRoot = resolve(extensionRoot, 'public')

/** The size set manifest.json must declare; the Chrome icon contract. */
const iconSizes = [
  { size: 16, path: 'icons/icon16.png' },
  { size: 32, path: 'icons/icon32.png' },
  { size: 48, path: 'icons/icon48.png' },
  { size: 128, path: 'icons/icon128.png' },
]

const iconRecord = Object.fromEntries(iconSizes.map(({ size, path }) => [String(size), path]))

interface PackageManifest {
  scripts?: Record<string, string>
}

interface ExtensionManifest {
  action?: { default_icon?: Record<string, string> }
  icons?: Record<string, string>
}

function readPngHeader(path: string): { width: number; height: number; bitDepth: number; colorType: number } {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24] ?? -1,
    colorType: bytes[25] ?? -1,
  }
}

describe('extension brand assets', () => {
  it('checks committed icon derivatives before every extension build', () => {
    const pkg = JSON.parse(readFileSync(resolve(extensionRoot, 'package.json'), 'utf8')) as PackageManifest
    const build = pkg.scripts?.build ?? ''
    expect(build).toContain('check:icons')
    expect(build.indexOf('check:icons')).toBeLessThan(build.indexOf('vite build'))
    expect(pkg.scripts?.['generate:icons'] ?? '').toContain('generate-icons.mjs')
    expect(pkg.scripts?.['check:icons'] ?? '').toContain('generate-icons.mjs')
  })

  it('maps both extension icon surfaces to the complete PNG size set', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'manifest.json'), 'utf8')) as ExtensionManifest
    expect(manifest.action?.default_icon).toEqual(iconRecord)
    expect(manifest.icons).toEqual(iconRecord)
  })

  it.each(iconSizes)('ships a $size px eight-bit RGBA PNG', ({ size, path }) => {
    expect(readPngHeader(resolve(publicRoot, path))).toEqual({
      width: size,
      height: size,
      bitDepth: 8,
      colorType: 6,
    })
  })

  it('uses the extension SVG as the documentation-site favicon source', () => {
    expect(readFileSync(resolve(repositoryRoot, 'website', 'public', 'favicon.svg')))
      .toEqual(readFileSync(resolve(publicRoot, 'icons', 'icon.svg')))
  })
})
