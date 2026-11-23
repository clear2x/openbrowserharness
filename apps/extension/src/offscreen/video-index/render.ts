/**
 * Model-facing render for the video_index tool outcomes: one text block per
 * call, the query's evidence context verbatim.
 *
 * @module video-index/render
 */

import { formatTimestamp } from './retrieval.ts'
import type { VideoIndexToolValue } from './types.ts'

/** Human labels for the subtitle source. */
const SUBTITLE_SOURCE_LABEL: Record<string, string> = {
  'bilibili-official': '官方字幕',
  'bilibili-ai': 'AI 字幕',
  asr: '本地语音识别（Whisper）',
  none: '无字幕',
}

/**
 * Format one duration as `h:mm:ss`.
 * @param ms - the duration in milliseconds.
 * @returns the display duration.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The index/status sentence that states where a local transcript stops;
 * empty when the transcript reaches the video's end.
 * @param value - the index or status outcome.
 * @returns the sentence with its leading separator, or an empty string.
 */
function coverageText(value: VideoIndexToolValue): string {
  if (value.asrCoveredMs === undefined || value.durationMs === undefined || value.asrCoveredMs >= value.durationMs) return ''
  return `；本地转写覆盖 0:00:00–${formatDuration(value.asrCoveredMs)}，其后 ${formatDuration(value.durationMs - value.asrCoveredMs)} 未转写（本机转写速度有限，该时段的内容无法从索引回答）`
}

/**
 * Render the model-visible text for one outcome.
 * @param value - the tool outcome.
 * @returns the presentation text; the query's evidence context verbatim.
 */
export function renderText(value: VideoIndexToolValue): string {
  if (!value.ok) {
    return `失败：${value.error ?? '未知原因'}`
  }
  const duration = value.durationMs === undefined ? '' : formatDuration(value.durationMs)
  switch (value.action) {
    case 'index':
      return `已建立索引：${value.title ?? ''}（时长 ${duration}，${value.utteranceCount ?? 0} 条台词，${value.chunkCount ?? 0} 个分块；字幕来源：${labelOf(value.subtitleSource)}${coverageText(value)}）\n索引键 ${value.videoKey ?? ''} —— 后续提问时把它作为 videoKey 参数传入。`
    case 'query':
      return value.context ?? '（无返回内容）'
    case 'status':
      return `索引 ${value.videoKey ?? ''}：${value.title ?? ''}，时长 ${duration}，${value.utteranceCount ?? 0} 条台词 / ${value.chunkCount ?? 0} 分块，字幕来源 ${labelOf(value.subtitleSource)}${coverageText(value)}，帧证据 ${value.frameCount ?? 0} 条，版本 ${value.revision ?? 1}。`
    case 'list': {
      const entries = value.entries ?? []
      if (entries.length === 0) return '还没有任何索引——用 index 动作从一个 B 站视频页 URL 开始。'
      const lines = entries.map(entry =>
        `${entry.videoKey} — ${entry.title}（时长 ${formatDuration(entry.durationMs)}，${entry.utteranceCount} 条台词，${labelOf(entry.subtitleSource)}）`,
      )
      return `共 ${entries.length} 个索引：\n${lines.join('\n')}`
    }
    case 'remove':
      return `已删除索引：${value.videoKey ?? ''}（原视频不受影响）`
    case 'zoom': {
      const at = value.timestampMs === undefined ? '' : formatTimestamp(value.timestampMs)
      const size = value.image === undefined ? '' : `（${String(value.image.width)}×${String(value.image.height)}，已作为图片返回给你）`
      const seeked = value.seekedToMs === undefined ? '' : `，播放器实际停在 ${formatTimestamp(value.seekedToMs)}`
      const cited = value.frameId === undefined ? '' : `，帧证据编号 ${value.frameId}（引用画面证据时用它或给出时间点）`
      const ocr = value.ocrLines === undefined || value.ocrLines.length === 0
        ? ''
        : `画面字幕（本地 OCR 读取）：${value.ocrLines.join(' / ')}。`
      const described = value.caption === undefined || value.caption.length === 0
        ? ''
        : `画面描述（本地模型）：${value.caption}`
      return `画面帧已截取：[at ${at}]${size}${seeked}${cited}。${ocr}${described}`
    }
    default:
      return `完成：${String(value.action)}`
  }
}

/**
 * Label one subtitle source.
 * @param source - the raw source label.
 * @returns the human label.
 */
function labelOf(source: string | undefined): string {
  if (source === undefined) return '未知'
  return SUBTITLE_SOURCE_LABEL[source] ?? source
}
