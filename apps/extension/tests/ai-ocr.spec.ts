/**
 * The OCR pipeline's pure math: det input geometry/normalization, the
 * simplified DBNet box extraction, rec cropping, and CTC decoding. The ONNX
 * sessions themselves are exercised by the on-device probe.
 *
 * @module ai-ocr.spec
 */
import { describe, expect, it } from 'vitest'
import {
  ctcDecode,
  detInputFrom,
  DET_SIDE_MULTIPLE,
  recInputFrom,
  textBoxesFrom,
} from '../src/offscreen/ai-runtime/ocr.ts'

/** A solid-color RGBA buffer. */
function solid(width: number, height: number, r = 0, g = 0, b = 0): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = r
    pixels[index * 4 + 1] = g
    pixels[index * 4 + 2] = b
    pixels[index * 4 + 3] = 255
  }
  return pixels
}

describe('detInputFrom', () => {
  it('rounds geometry to 32-multiples within the 960 cap', () => {
    const pixels = solid(1920, 1080)
    const input = detInputFrom(pixels, 1920, 1080)
    expect(input.width % DET_SIDE_MULTIPLE).toBe(0)
    expect(input.height % DET_SIDE_MULTIPLE).toBe(0)
    expect(input.width).toBeLessThanOrEqual(960)
    expect(input.data.length).toBe(3 * input.width * input.height)
  })

  it('normalizes the center pixel to the ImageNet contract for a mid-gray frame', () => {
    const pixels = solid(32, 32, 128, 128, 128)
    const input = detInputFrom(pixels, 32, 32)
    expect(input.data[0]).toBeCloseTo((128 / 255 - 0.485) / 0.229, 5)
    // Green channel lands in the second plane.
    expect(input.data[32 * 32]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 5)
  })
})

describe('textBoxesFrom', () => {
  it('finds one box over a bright subtitle block and none on a dark frame', () => {
    const width = 320
    const height = 180
    const probMap = new Float32Array(width * height)
    // A subtitle-sized bright rectangle low in the frame.
    for (let y = 140; y < 168; y += 1) {
      for (let x = 60; x < 260; x += 1) probMap[y * width + x] = 0.9
    }
    const boxes = textBoxesFrom(probMap, width, height, 1280, 720)
    expect(boxes.length).toBe(1)
    const box = boxes[0]!
    expect(box.y).toBeGreaterThan(400)
    expect(box.width).toBeGreaterThan(200)

    const empty = textBoxesFrom(new Float32Array(width * height), width, height, 1280, 720)
    expect(empty.length).toBe(0)
  })

  it('orders two stacked boxes top to bottom', () => {
    const width = 320
    const height = 200
    const probMap = new Float32Array(width * height)
    for (let y = 20; y < 40; y += 1) {
      for (let x = 40; x < 280; x += 1) probMap[y * width + x] = 0.8
    }
    for (let y = 120; y < 140; y += 1) {
      for (let x = 40; x < 280; x += 1) probMap[y * width + x] = 0.8
    }
    const boxes = textBoxesFrom(probMap, width, height, 1280, 800)
    expect(boxes.length).toBe(2)
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y)
  })
})

describe('recInputFrom', () => {
  it('crops a region at 48 height with width scaled from the aspect', () => {
    const frameWidth = 640
    const frameHeight = 360
    const pixels = solid(frameWidth, frameHeight, 200, 100, 50)
    const crop = recInputFrom(pixels, frameWidth, frameHeight, { x: 100, y: 280, width: 400, height: 60 })
    expect(crop.width).toBe(Math.round((400 / 60) * 48))
    expect(crop.data.length).toBe(3 * 48 * crop.width)
    // The rec input carries raw [0,1] scaling.
    expect(crop.data[0]).toBeCloseTo(200 / 255, 5)
  })
})

describe('ctcDecode', () => {
  const dict = ['你', '好', '世', '界']

  /** One hot row: class `best` wins. */
  const row = (classes: number, best: number): number[] => Array.from({ length: classes }, (_unused, c) => (c === best ? 5 : 0))

  it('decodes distinct classes through the dictionary and collapses plain repeats', () => {
    const classes = dict.length + 2 // blank + dict + space
    const rows: number[] = []
    // 你 好 好(collapsed) space 世 界 → 你好 世界
    for (const best of [1, 2, 2, dict.length + 1, 3, 4]) rows.push(...row(classes, best))
    const text = ctcDecode(new Float32Array(rows), 6, classes, dict)
    expect(text).toBe('你好 世界')
  })

  it('keeps blank-separated repeats as two real characters (CTC rule)', () => {
    const classes = dict.length + 2
    const rows: number[] = []
    for (const best of [1, 0, 1]) rows.push(...row(classes, best))
    expect(ctcDecode(new Float32Array(rows), 3, classes, dict)).toBe('你你')
  })

  it('returns empty for an all-blank output', () => {
    const classes = dict.length + 2
    const rows: number[] = []
    for (let t = 0; t < 5; t += 1) rows.push(...row(classes, 0))
    expect(ctcDecode(new Float32Array(rows), 5, classes, dict)).toBe('')
  })
})
