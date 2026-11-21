/**
 * Durable image-evidence commit shared by the model-facing capture tools
 * (`video_index` zoom, `sense_now` watch): the page_screenshot gate
 * discipline — route gating, byte caps, and attachment save all run before
 * any caller sees a committed value, so a refusal never leaves a partial
 * attachment behind.
 *
 * @module image-evidence
 */
import type { ZoomHost } from './video-index/types.ts'

/**
 * The minimal call context image commit needs: the cancellation signal plus
 * the calling agent's routed model facts (structural face — the real
 * ToolRunContext satisfies it; `| undefined` members accept the real shapes
 * under exactOptionalPropertyTypes).
 */
export interface VideoIndexCallContext {
  signal: AbortSignal
  agent?: {
    session?: { requestHeader?(): { config?: { provider?: string; model?: string } } | undefined } | undefined
    options?: { provider?: string; model?: string } | undefined
  } | undefined
}

/** The route-resolving face of the llm service (route gating for images). */
type LlmFace = NonNullable<ReturnType<ZoomHost['llm']>>

/** One committed image evidence reference (attachment-store fields). */
export interface ImageEvidenceRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/**
 * Enforce the image-capability gate for the calling route (the
 * page_screenshot discipline): the session's routed provider/model must
 * declare image input — a tool result enters durable session history, so
 * emitting an image on a route that cannot carry it would break that route's
 * continuation.
 * @param llm - the llm service face, or undefined when the service is absent.
 * @param exec - the tool-execution context supplying the calling agent.
 */
export async function assertImageCapableRoute(llm: LlmFace | undefined, exec: VideoIndexCallContext): Promise<void> {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('无法解析当前模型路由——图片证据需要可路由的模型')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`模型 "${model}" 未声明图片输入——请切换支持图片的模型后再采集画面`)
  }
}

/**
 * Commit one captured frame through the attachment service.
 * @param frame - the raw capture (bytes plus intrinsic size).
 * @param host - the call-time attachment/llm services.
 * @param exec - the tool-execution context.
 * @param name - the attachment display name (names the offload placeholder).
 * @returns the committed reference, or the honest refusal.
 */
export async function commitImageEvidence(
  frame: { data: Uint8Array; width: number; height: number },
  host: ZoomHost | undefined,
  exec: VideoIndexCallContext,
  name: string,
): Promise<{ ok: true; image: ImageEvidenceRef } | { ok: false; error: string }> {
  const attachments = host?.attachments()
  if (host === undefined || attachments === undefined) {
    return { ok: false, error: '附件服务未挂载，无法保存画面' }
  }
  try {
    await assertImageCapableRoute(host.llm(), exec)
    const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
    if (frame.data.byteLength > byteCap) {
      return { ok: false, error: `画面 ${String(frame.data.byteLength)} 字节超出部署上限 ${String(byteCap)} 字节` }
    }
    const ref = await attachments.saveImage({
      data: frame.data,
      mediaType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
      name,
    })
    return {
      ok: true,
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
