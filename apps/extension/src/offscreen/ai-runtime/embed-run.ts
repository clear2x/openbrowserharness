/**
 * The embedding runner (batch 277): multilingual-e5-small through
 * transformers.js's feature-extraction pipeline (mean pooling, normalized —
 * the e5 contract), used for the DOM-candidate semantic pre-filter. CPU
 * (wasm) tier: a 118M encoder embeds a page's element texts in well under a
 * second, and embeddings are the one task where CPU is fully competitive.
 * Weights ride transformers.js's Cache-API cache; the mirror hosts them
 * when the direct origin is unreachable.
 *
 * @module ai-runtime/embed-run
 */

// The browser entry only: the node entry pulls sharp/onnxruntime-node.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/** The model the embedding capability ships with (quantized, ~113 MB). */
export const EMBED_MODEL_ID = 'Xenova/multilingual-e5-small'
export const EMBED_DTYPE = 'q8' as const

/** e5's asymmetric prefixes: queries and passages are encoded differently. */
export const QUERY_PREFIX = 'query: '
export const PASSAGE_PREFIX = 'passage: '

let embedPipeline: FeatureExtractionPipeline | undefined

/**
 * Load (once) the embedding pipeline; the mirror hosts the weights when the
 * direct origin is unreachable.
 */
async function ensureEmbedPipeline(): Promise<FeatureExtractionPipeline> {
  if (embedPipeline !== undefined) return embedPipeline
  env.remoteHost = 'https://hf-mirror.com'
  env.allowLocalModels = false
  const wasm = env.backends.onnx.wasm as { wasmPaths?: string } | undefined
  if (wasm !== undefined) wasm.wasmPaths = '/ort-tjs/'
  embedPipeline = await pipeline('feature-extraction', EMBED_MODEL_ID, {
    dtype: EMBED_DTYPE,
    device: 'wasm',
  })
  return embedPipeline
}

/**
 * Embed one query and its candidate passages into the same normalized
 * space; cosine similarity ranks them.
 * @param query - the task text (e5 query prefix applied here).
 * @param passages - the candidate texts (e5 passage prefix applied here).
 * @returns `{ query, passages }` vectors, each normalized, row-major.
 */
export async function embedQueryAndPassages(query: string, passages: string[]): Promise<{
  query: Float32Array
  passages: Float32Array
  dim: number
}> {
  const extractor = await ensureEmbedPipeline()
  const output = await extractor([QUERY_PREFIX + query, ...passages.map(passage => PASSAGE_PREFIX + passage)], {
    pooling: 'mean',
    normalize: true,
  })
  const dims = output.dims as number[]
  const dim = dims.at(-1) ?? 0
  const data = output.data as Float32Array
  return {
    query: data.slice(0, dim),
    passages: data.slice(dim),
    dim,
  }
}

/**
 * The embedding row's self-proof, worker-side: semantically related texts
 * must score clearly higher than an unrelated one — the exact property the
 * DOM pre-filter depends on.
 * @param related - a passage paraphrasing the query.
 * @param unrelated - a passage on a different topic.
 * @returns the three cosine scores (query-related, query-unrelated).
 */
export async function embedSelfTestInWorker(related: string, unrelated: string): Promise<{
  relatedScore: number
  unrelatedScore: number
}> {
  const { query, passages } = await embedQueryAndPassages('用户想登录他的账号', [related, unrelated])
  const cosine = (a: Float32Array, b: Float32Array): number => {
    let dot = 0
    for (let index = 0; index < a.length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0)
    return dot
  }
  const relatedScore = cosine(query, passages.slice(0, query.length))
  const unrelatedScore = cosine(query, passages.slice(query.length))
  return { relatedScore, unrelatedScore }
}

/**
 * Download-and-warm the embedding pipeline (the `aiLocal.install` verb).
 */
export async function warmEmbedPipeline(): Promise<void> {
  await ensureEmbedPipeline()
}

/**
 * Drop the transformers.js Cache-API cache (shared across all tjs models —
 * the manager clears every tjs row's state entry alongside).
 */
export async function dropEmbedCache(): Promise<void> {
  await caches.delete('transformers-cache')
  embedPipeline = undefined
}
