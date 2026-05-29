import { create } from 'zustand'

/// DeepSeek 设置：独立 store + localStorage 持久化(不进 Tauri 配置文件,key 留本机)。
/// 用 OpenAI 兼容端点 /v1/chat/completions —— res.model 诚实(不踩 anthropic-compat 假回显坑)。

export interface DeepSeekSettings {
  baseUrl: string
  model: string
  apiKey: string
}

const LS_KEY = 'quay.deepseek'
const DEFAULTS: DeepSeekSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  apiKey: '',
}

function load(): DeepSeekSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEFAULTS
}

interface SettingsStore {
  deepseek: DeepSeekSettings
  /** key 已配置 → AI 能力可用 */
  configured: boolean
  save: (s: Partial<DeepSeekSettings>) => void
}

export const useSettings = create<SettingsStore>((set, get) => {
  const initial = load()
  return {
    deepseek: initial,
    configured: !!initial.apiKey.trim(),
    save: (patch) => {
      const deepseek = { ...get().deepseek, ...patch }
      localStorage.setItem(LS_KEY, JSON.stringify(deepseek))
      set({ deepseek, configured: !!deepseek.apiKey.trim() })
    },
  }
})

/// 2026-05 起 deepseek-chat/reasoner 将于 2026/07/24 弃用,默认推 v4-flash/pro。
export const DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
]
