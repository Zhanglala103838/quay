import { create } from 'zustand'

/// DeepSeek 设置：独立 store + localStorage 持久化(不进 Tauri 配置文件,key 留本机)。
/// 用 OpenAI 兼容端点 /v1/chat/completions —— res.model 诚实(不踩 anthropic-compat 假回显坑)。

export interface DeepSeekSettings {
  baseUrl: string
  model: string
  apiKey: string
}

/// 渲染设置:GPU 渲染加速 = 给激活终端挂 xterm WebGL addon(WKWebView 里 WebGL2 → ANGLE→Metal)。
/// 关闭则退回 xterm 默认 DOM 渲染器(纯 CPU,低功耗/兼容但大量输出时更卡)。默认开。
export interface RenderSettings {
  gpuAcceleration: boolean
  /** 终端字体(见 lib/fonts.ts 注册表 key) */
  termLatin: string
  termCJK: string
  termFontSize: number
  /** 界面(非终端)字体 */
  uiLatin: string
  uiCJK: string
}

/// 调试设置:开启后右键菜单追加「检查元素」(调 Rust open_devtools)。默认关,避免普通用户误触。
export interface DebugSettings {
  enabled: boolean
}

const LS_KEY = 'quay.deepseek'
const DEFAULTS: DeepSeekSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  apiKey: '',
}

const RENDER_LS_KEY = 'quay.render'
const RENDER_DEFAULTS: RenderSettings = {
  gpuAcceleration: true,
  termLatin: 'jetbrains',
  termCJK: 'pingfang',
  termFontSize: 13,
  uiLatin: 'jetbrains',
  uiCJK: 'pingfang',
}

const DEBUG_LS_KEY = 'quay.debug'
const DEBUG_DEFAULTS: DebugSettings = {
  enabled: false,
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

function loadRender(): RenderSettings {
  try {
    const raw = localStorage.getItem(RENDER_LS_KEY)
    if (raw) return { ...RENDER_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return RENDER_DEFAULTS
}

function loadDebug(): DebugSettings {
  try {
    const raw = localStorage.getItem(DEBUG_LS_KEY)
    if (raw) return { ...DEBUG_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return DEBUG_DEFAULTS
}

interface SettingsStore {
  deepseek: DeepSeekSettings
  /** key 已配置 → AI 能力可用 */
  configured: boolean
  save: (s: Partial<DeepSeekSettings>) => void
  render: RenderSettings
  saveRender: (s: Partial<RenderSettings>) => void
  debug: DebugSettings
  saveDebug: (s: Partial<DebugSettings>) => void
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
    render: loadRender(),
    saveRender: (patch) => {
      const render = { ...get().render, ...patch }
      localStorage.setItem(RENDER_LS_KEY, JSON.stringify(render))
      set({ render })
    },
    debug: loadDebug(),
    saveDebug: (patch) => {
      const debug = { ...get().debug, ...patch }
      localStorage.setItem(DEBUG_LS_KEY, JSON.stringify(debug))
      set({ debug })
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
