/**
 * Display copy of the shipped agent presets, keyed by preset id (the table in
 * `preset-labels.ts`): `zh` is the roster's own wording, `en` its translation.
 *
 * @module extension-shell-locales-presets
 */

export const presetsZh = {
  'presetLabel.standard.name': '标准模式',
  'presetLabel.standard.description': '功能完整的浏览器 Agent：页面浏览与操作、脚本检查、站点知识、计划、目标与子代理全量可用。',
  'presetLabel.ptc.name': 'PTC 模式',
  'presetLabel.ptc.description': '多步操作优先合成为一个程序执行：环境提供 run_code 时用 TypeScript 组合多步操作，减少往返。',
  'presetLabel.minimal.name': '极简模式',
  'presetLabel.minimal.description': '最小工具用量：能一步完成就不多步，能不调用工具就不调用。',
  'presetLabel.cordis.name': '创造模式',
  'presetLabel.cordis.description': '用于创建自定义 Agent 预设：帮你把角色、工作方式与边界整理成可保存的预设定义。',
  'presetLabel.webResearch.name': '网页研究员',
  'presetLabel.webResearch.description': '深读网页、多源交叉验证，结论附出处',
  'presetLabel.pageMonitor.name': '页面哨兵',
  'presetLabel.pageMonitor.description': '周期观察页面变化，只读不写，有变化才报告',
  'presetLabel.devProbe.name': '页面调试手',
  'presetLabel.devProbe.description': '面向开发者：DOM/控制台只读探查，帮定位页面问题',
  'presetLabel.stockWatcher.name': '股市通',
  'presetLabel.stockWatcher.description': '监听预设的财经 UP 主最新动态，视频必读内容，提炼个股与市场信号；配合定时任务做每日增量监控。',
} as const

export type PresetsLocaleKey = keyof typeof presetsZh

export const presetsEn: Record<PresetsLocaleKey, string> = {
  'presetLabel.standard.name': 'Standard mode',
  'presetLabel.standard.description': 'The full-featured browser agent: page browsing and actions, script inspection, site knowledge, plans, goals, and subagents are all available.',
  'presetLabel.ptc.name': 'PTC mode',
  'presetLabel.ptc.description': 'Multi-step actions prefer one composed program: when run_code is available, steps are combined in TypeScript to cut round trips.',
  'presetLabel.minimal.name': 'Minimal mode',
  'presetLabel.minimal.description': 'Fewest tool calls: one step when one suffices, and no tool call when none is needed.',
  'presetLabel.cordis.name': 'Creator mode',
  'presetLabel.cordis.description': 'For building custom agent presets: helps turn a role, a working style, and boundaries into a preset definition you can save.',
  'presetLabel.webResearch.name': 'Web researcher',
  'presetLabel.webResearch.description': 'Reads pages in depth, cross-checks sources, and cites where each conclusion comes from',
  'presetLabel.pageMonitor.name': 'Page sentinel',
  'presetLabel.pageMonitor.description': 'Watches a page for changes on a schedule; read-only, and reports only when something changed',
  'presetLabel.devProbe.name': 'Page debugger',
  'presetLabel.devProbe.description': 'For developers: read-only DOM and console probing to help locate page problems',
  'presetLabel.stockWatcher.name': 'Stock watcher',
  'presetLabel.stockWatcher.description': 'Watches the finance creators you choose, reads every video, and distills stock and market signals; pair it with a schedule for daily checks',
}
