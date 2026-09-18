import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(extensionRoot, '..', '..')
const publicRoot = resolve(extensionRoot, 'public')
const iconRoot = resolve(publicRoot, 'icons')

const iconPaths = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
} as const

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
    expect(pkg.scripts?.['generate:icons']).toBe('node scripts/generate-icons.mjs')
    expect(pkg.scripts?.['check:icons']).toBe('node scripts/generate-icons.mjs --check')
    expect(pkg.scripts?.build).toBe('pnpm run check:icons && vite build')
  })

  it('maps both extension icon surfaces to the complete PNG size set', () => {
    const manifest = JSON.parse(readFileSync(resolve(publicRoot, 'manifest.json'), 'utf8')) as ExtensionManifest
    expect(manifest.action?.default_icon).toEqual(iconPaths)
    expect(manifest.icons).toEqual(iconPaths)
  })

  it.each(Object.entries(iconPaths))('ships a %spx eight-bit RGBA PNG', (sizeText, relativePath) => {
    const size = Number(sizeText)
    expect(readPngHeader(resolve(publicRoot, relativePath))).toEqual({
      width: size,
      height: size,
      bitDepth: 8,
      colorType: 6,
    })
  })

  it('uses the extension SVG as the documentation-site favicon source', () => {
    expect(readFileSync(resolve(repositoryRoot, 'website', 'public', 'favicon.svg')))
      .toEqual(readFileSync(resolve(iconRoot, 'icon.svg')))
  })
})
