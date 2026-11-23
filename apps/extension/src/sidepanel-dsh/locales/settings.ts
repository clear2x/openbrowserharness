/**
 * Copy of the settings root and the shell's transport and workspace helpers.
 * The transport refusals surface in the shell's notices, so they follow the
 * locale like any other copy.
 *
 * @module extension-shell-locales-settings
 */

export const settingsZh = {
  'settings.title': '设置',
  'settings.back': '返回',
  'settings.closeLabel': '关闭设置',
  'settings.loading': '设置加载中…',
  'settings.general': '通用设置',

  'rpc.runtimeUnavailable': 'chrome.runtime 在当前环境不可用',
  'rpc.bridgeDisconnected': 'dsh-api 桥已断开',
  'rpc.timeout': 'dsh-api RPC 超时',

  'workspace.pickerUnsupported': '此浏览器不支持选择本地文件夹',
} as const

export type SettingsLocaleKey = keyof typeof settingsZh

export const settingsEn: Record<SettingsLocaleKey, string> = {
  'settings.title': 'Settings',
  'settings.back': 'Back',
  'settings.closeLabel': 'Close settings',
  'settings.loading': 'Loading settings…',
  'settings.general': 'General',

  'rpc.runtimeUnavailable': 'chrome.runtime is unavailable in this environment',
  'rpc.bridgeDisconnected': 'The dsh-api bridge disconnected',
  'rpc.timeout': 'The dsh-api RPC timed out',

  'workspace.pickerUnsupported': 'This browser cannot pick a local folder',
}
