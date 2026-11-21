/**
 * Generate the committed brand-icon derivatives from the single SVG source:
 *
 *   scripts/generate-icons.mjs            → writes the four manifest PNGs, the
 *                                           website favicon copy, the site
 *                                           favicon.ico and the apple touch icon
 *   scripts/generate-icons.mjs --check    → exits 1 when any committed copy
 *                                           no longer matches the source
 *
 * `public/icons/icon.svg` is the only vector source of truth. The four PNGs
 * (16/32/48/128) are what manifest.json references for both
 * `action.default_icon` and the top-level `icons`; `website/public/favicon.svg`
 * must stay a byte copy of the source or the docs site and the extension drift
 * apart (they did once). The site derivatives exist for the browsers and
 * surfaces that skip SVG favicons: Safari and cached-favicon fallbacks read
 * `favicon.ico`, and iOS home screens read `apple-touch-icon.png`. The
 * extension build runs --check first, so editing the SVG without regenerating
 * fails loudly instead of shipping stale artwork.
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
const siteIcoPath = join(repositoryRoot, 'website', 'public', 'favicon.ico')
const touchIconPath = join(repositoryRoot, 'website', 'public', 'apple-touch-icon.png')

/** The exact sizes manifest.json declares; square viewBox keeps width == height. */
const SIZES = [16, 32, 48, 128]

/** The sizes packed into the site favicon.ico (small read sizes only). */
const ICO_SIZES = [16, 32, 48]

/** The size iOS home-screen bookmarks read from apple-touch-icon.png. */
const TOUCH_ICON_SIZE = 180

/** Render the source SVG to a PNG byte buffer at one of the manifest sizes. */
function renderPng(source, size) {
  return new Resvg(source, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  }).render().asPng()
}

/**
 * Pack rendered PNGs into an ICO container. Vista and later read PNG frames
 * directly, so the frames need no BMP re-encoding; sizes are stored in the
 * directory entry with 256 encoded as 0.
 * @param {Array<{size: number, bytes: Buffer}>} frames - rendered frames, smallest first.
 * @returns {Buffer} the multi-size ICO file bytes.
 */
function packIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  const directorySize = 16 * frames.length
  const entries = []
  let offset = header.length + directorySize
  for (const { size, bytes } of frames) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2) // palette count: PNG frames carry none
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(bytes.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += bytes.length
    entries.push(entry)
  }
  return Buffer.concat([header, ...entries, ...frames.map(frame => frame.bytes)])
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

  const icoFrames = ICO_SIZES.map(size => ({ size, bytes: renderPng(source, size) }))
  const touchIcon = renderPng(source, TOUCH_ICON_SIZE)

  if (check) {
    const committed = readCommittedOrNull(faviconPath)
    if (committed === null || !committed.equals(source)) {
      console.error('generate-icons: website/public/favicon.svg drifted from public/icons/icon.svg. Run `pnpm --filter openbrowserharness-extension run generate:icons` and commit it.')
      stale = true
    }
    const committedIco = readCommittedOrNull(siteIcoPath)
    if (committedIco === null || !committedIco.equals(packIco(icoFrames))) {
      console.error('generate-icons: website/public/favicon.ico is stale. Run `pnpm --filter openbrowserharness-extension run generate:icons` and commit it.')
      stale = true
    }
    const committedTouch = readCommittedOrNull(touchIconPath)
    if (committedTouch === null || !committedTouch.equals(touchIcon)) {
      console.error('generate-icons: website/public/apple-touch-icon.png is stale. Run `pnpm --filter openbrowserharness-extension run generate:icons` and commit it.')
      stale = true
    }
    if (stale) process.exit(1)
    console.log('generate-icons: committed icon derivatives are up to date.')
    return
  }

  writeFileSync(faviconPath, source)
  writeFileSync(siteIcoPath, packIco(icoFrames))
  writeFileSync(touchIconPath, touchIcon)
  console.log(`generate-icons: wrote ${SIZES.map(size => `icon${size}.png`).join(', ')}, website/public/favicon.svg, website/public/favicon.ico and website/public/apple-touch-icon.png.`)
}

await main()
