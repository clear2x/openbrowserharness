/**
 * Generate the committed brand-icon derivatives from the single SVG source:
 *
 *   scripts/generate-icons.mjs            → writes the four manifest PNGs and
 *                                           the website favicon copy
 *   scripts/generate-icons.mjs --check    → exits 1 when any committed copy
 *                                           no longer matches the source
 *
 * `public/icons/icon.svg` is the only vector source of truth. The four PNGs
 * (16/32/48/128) are what manifest.json references for both
 * `action.default_icon` and the top-level `icons`; `website/public/favicon.svg`
 * must stay a byte copy of the source or the docs site and the extension drift
 * apart (they did once). The extension build runs --check first, so editing the
 * SVG without regenerating fails loudly instead of shipping stale artwork.
 * @module generate-icons
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { Resvg } = require('@resvg/resvg-js')

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const repositoryRoot = dirname(dirname(extensionRoot))

const sourcePath = join(extensionRoot, 'public', 'icons', 'icon.svg')
const iconDirectory = join(extensionRoot, 'public', 'icons')
const faviconPath = join(repositoryRoot, 'website', 'public', 'favicon.svg')

/** The exact sizes manifest.json declares; square viewBox keeps width == height. */
const SIZES = [16, 32, 48, 128]

/** Render the source SVG to a PNG byte buffer at one of the manifest sizes. */
function renderPng(source, size) {
  return new Resvg(source, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  }).render().asPng()
}

/** Read a committed derivative, or null when it does not exist yet. */
function readCommittedOrNull(path) {
  try {
    return readFileSync(path)
  } catch (error) {
    // A missing derivative is the stale state this gate reports; any other
    // read failure (permissions, EISDIR) must stay loud, not masquerade as stale.
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  const source = readFileSync(sourcePath)
  const check = process.argv.includes('--check')
  let stale = false

  for (const size of SIZES) {
    const rendered = renderPng(source, size)
    const path = join(iconDirectory, `icon${size}.png`)
    if (check) {
      const committed = readCommittedOrNull(path)
      if (committed === null || !committed.equals(rendered)) {
        console.error(`generate-icons: icon${size}.png is stale. Run \`pnpm --filter openbrowserharness-extension run generate:icons\` and commit it.`)
        stale = true
      }
      continue
    }
    writeFileSync(path, rendered)
  }

  if (check) {
    const committed = readCommittedOrNull(faviconPath)
    if (committed === null || !committed.equals(source)) {
      console.error('generate-icons: website/public/favicon.svg drifted from public/icons/icon.svg. Run `pnpm --filter openbrowserharness-extension run generate:icons` and commit it.')
      stale = true
    }
    if (stale) process.exit(1)
    console.log('generate-icons: committed icon derivatives are up to date.')
    return
  }

  writeFileSync(faviconPath, source)
  console.log(`generate-icons: wrote ${SIZES.map(size => `icon${size}.png`).join(', ')} and website/public/favicon.svg.`)
}

await main()
