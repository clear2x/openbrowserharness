/**
 * Locale keys for the on-device model catalog rows. The host catalog
 * (`offscreen/ai-runtime/catalog.ts`) carries each model's label and purpose
 * in zh only (`label`, `purposeZh`); the services card looks both up here so
 * an `en` reader sees the translation, and a model id missing here keeps the
 * catalog's zh wording.
 *
 * @module extension-shell-locales-ai-local
 */
import type { ShellLocaleKey } from './index.ts'

/** Dictionary key of each catalog row's display label, by model id. */
export const AI_LOCAL_LABEL_KEYS: Readonly<Record<string, ShellLocaleKey>> = {
  'embed-e5-small': 'aiLocal.model.embedE5Small',
  'ocr-ppocr-mobile': 'aiLocal.model.ocrPpocrMobile',
  'caption-smolvlm2-256m': 'aiLocal.model.captionSmolvlm2',
  'asr-whisper-base': 'aiLocal.model.asrWhisperBase',
  'asr-whisper-small': 'aiLocal.model.asrWhisperSmall',
}

/** Dictionary key of each catalog row's purpose, by model id. */
export const AI_LOCAL_PURPOSE_KEYS: Readonly<Record<string, ShellLocaleKey>> = {
  'embed-e5-small': 'aiLocal.purpose.embed',
  'ocr-ppocr-mobile': 'aiLocal.purpose.ocr',
  'caption-smolvlm2-256m': 'aiLocal.purpose.caption',
  'asr-whisper-base': 'aiLocal.purpose.asrBase',
  'asr-whisper-small': 'aiLocal.purpose.asrSmall',
}
