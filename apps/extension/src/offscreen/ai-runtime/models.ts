/**
 * The on-device model store: file manifests, the streaming HF downloader
 * (direct origin first, hf-mirror.com fallback), and the OPFS layout under
 * `ai-local/models/<modelId>/`. A per-model `manifest.json` written LAST is
 * the publication marker (the video-index store precedent): a partial
 * download reads as absent and re-install simply overwrites.
 *
 * @module ai-runtime/models
 */

/** One downloadable artifact of a model. */
export interface ModelFileSpec {
  /** The file name inside the model's OPFS directory. */
  name: string
  /** The path on the model host (appended to the origin base), or an absolute URL. */
  remotePath: string
  /** The expected byte size; a mismatched download fails the install. */
  bytes: number
  /** An absolute fallback URL tried when every origin attempt fails. */
  fallbackUrl?: string
}

/** One installable model's full manifest. */
export interface ModelSpec {
  /** The catalog id this spec belongs to. */
  modelId: string
  /** Direct download origin. */
  origin: string
  /** Mirror origin consulted when the direct origin fails. */
  mirrorOrigin: string
  files: ModelFileSpec[]
}

/** The PP-OCRv4 mobile Chinese det+rec pair plus its CTC dictionary. */
export const OCR_PPOCR_MOBILE_SPEC: ModelSpec = {
  modelId: 'ocr-ppocr-mobile',
  origin: 'https://huggingface.co',
  mirrorOrigin: 'https://hf-mirror.com',
  files: [
    { name: 'det.onnx', remotePath: '/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx', bytes: 4_745_517 },
    { name: 'rec.onnx', remotePath: '/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx', bytes: 10_857_958 },
    {
      name: 'keys.txt',
      // PaddleOCR's upstream path (6623 lines, no trailing newline); the
      // jsdelivr CDN mirror rides the fallback slot for blocked raw access.
      remotePath: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt',
      bytes: 26_250,
      fallbackUrl: 'https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@main/ppocr/utils/ppocr_keys_v1.txt',
    },
  ],
}

/** Download failure with a stable code for the card and probes. */
export class ModelDownloadError extends Error {
  readonly code: 'MODEL_FETCH_FAILED' | 'MODEL_SIZE_MISMATCH'

  constructor(message: string, code: 'MODEL_FETCH_FAILED' | 'MODEL_SIZE_MISMATCH') {
    super(message)
    this.name = 'ModelDownloadError'
    this.code = code
  }
}

/**
 * The OPFS byte face the store needs — the attachment-store's sink shape,
 * restricted to what the downloader and the OCR pipeline read back.
 */
export interface ModelBytesStore {
  /** Write one file (full overwrite). */
  put(path: string[], data: Uint8Array): Promise<void>
  /** Read one file, `undefined` when absent. */
  get(path: string[]): Promise<Uint8Array | undefined>
}

/**
 * The OPFS-backed store rooted at the extension origin, precedent
 * `opfsImageSink`: per-path directory walk, exclusive-create writeables.
 */
export function opfsModelStore(): ModelBytesStore {
  let rootPromise: Promise<FileSystemDirectoryHandle> | undefined
  const rootOf = (): Promise<FileSystemDirectoryHandle> => {
    rootPromise ??= (async () => {
      let root = await navigator.storage.getDirectory()
      for (const segment of ['ai-local', 'models']) {
        root = await root.getDirectoryHandle(segment, { create: true })
      }
      return root
    })()
    return rootPromise
  }
  return {
    async put(path, data) {
      const name = path.at(-1)
      if (name === undefined) throw new Error('model store: empty path')
      let dir = await rootOf()
      for (const segment of path.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(segment, { create: true })
      }
      const handle = await dir.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      // The chunk type requires an ArrayBuffer-backed view; a fresh wrapper
      // detaches the value from any SharedArrayBuffer-capable buffer type.
      await writable.write(new Uint8Array(data))
      await writable.close()
    },
    async get(path) {
      const name = path.at(-1)
      if (name === undefined) return undefined
      try {
        let dir = await rootOf()
        for (const segment of path.slice(0, -1)) {
          dir = await dir.getDirectoryHandle(segment)
        }
        const handle = await dir.getFileHandle(name)
        const file = await handle.getFile()
        return new Uint8Array(await file.arrayBuffer())
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
        throw error
      }
    },
  }
}

/** Progress callback: artifact name plus 0–1 fraction (file-granular). */
export type DownloadProgress = (fileName: string, fraction: number) => void

/**
 * Fetch one artifact with mirror fallback, verifying the byte size. A
 * direct-origin failure (network blocks, geo) silently falls to the mirror;
 * a mirror failure is the reported error.
 */
async function fetchOne(spec: ModelSpec, file: ModelFileSpec, onProgress: DownloadProgress): Promise<Uint8Array> {
  const urls = file.remotePath.startsWith('https://')
    ? [file.remotePath]
    : [spec.origin + file.remotePath, spec.mirrorOrigin + file.remotePath]
  if (file.fallbackUrl !== undefined) urls.push(file.fallbackUrl)
  let lastError = 'no attempt'
  for (const [attempt, url] of urls.entries()) {
    try {
      const response = await fetch(url)
      if (!response.ok || response.body === null) {
        lastError = `HTTP ${String(response.status)}`
        continue
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        onProgress(file.name, Math.min(0.99, received / Math.max(1, file.bytes)))
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      // Size tolerance: HF may re-encode text files with a trailing newline;
      // binaries must match exactly. Dictionary files get a 2KB slack.
      const slack = file.name.endsWith('.txt') ? 2048 : 0
      if (Math.abs(total - file.bytes) > slack) {
        throw new ModelDownloadError(
          `${file.name} 体积不符：期望 ${String(file.bytes)}B，实得 ${String(total)}B`,
          'MODEL_SIZE_MISMATCH',
        )
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      onProgress(file.name, 1)
      return merged
    } catch (error: unknown) {
      if (error instanceof ModelDownloadError) throw error
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === urls.length - 1) {
        throw new ModelDownloadError(`${file.name} 下载失败（直连与镜像都失败：${lastError}）`, 'MODEL_FETCH_FAILED')
      }
    }
  }
  throw new ModelDownloadError(`${file.name} 下载失败：${lastError}`, 'MODEL_FETCH_FAILED')
}

/**
 * Install one model: download every artifact (mirror fallback per file),
 * write the bytes into the OPFS model directory, then publish. Publication
 * is all-or-nothing per file; the manifest lands last.
 * @param spec - the model's file manifest.
 * @param store - the OPFS byte store.
 * @param onProgress - per-artifact progress.
 * @returns the installed byte total.
 */
export async function installModel(spec: ModelSpec, store: ModelBytesStore, onProgress: DownloadProgress): Promise<number> {
  const dir = [spec.modelId]
  let total = 0
  for (const file of spec.files) {
    const bytes = await fetchOne(spec, file, onProgress)
    await store.put([...dir, file.name], bytes)
    total += bytes.byteLength
  }
  // A failed fetch above leaves the already-written files in place but no
  // manifest: absence of the manifest is the absence of the install, and a
  // retry simply overwrites the partial artifacts.
  const manifest = `${JSON.stringify({ version: 1, files: spec.files.map(file => file.name), installedAt: Date.now() })}\n`
  await store.put([...dir, 'manifest.json'], new TextEncoder().encode(manifest))
  return total
}

/**
 * Whether one model's published manifest exists (the ready check the
 * manager caches at boot).
 * @param spec - the model's file manifest.
 * @param store - the OPFS byte store.
 */
export async function modelInstalled(spec: ModelSpec, store: ModelBytesStore): Promise<boolean> {
  const manifest = await store.get([spec.modelId, 'manifest.json'])
  return manifest !== undefined && manifest.byteLength > 2
}

/**
 * Remove one model's published directory (best-effort: the store has no
 * directory delete, so files are zeroed and the manifest cleared — the
 * absent-manifest read is the authority).
 * @param spec - the model's file manifest.
 * @param store - the OPFS byte store.
 */
export async function removeModel(spec: ModelSpec, store: ModelBytesStore): Promise<void> {
  await store.put([spec.modelId, 'manifest.json'], new Uint8Array(0))
}
