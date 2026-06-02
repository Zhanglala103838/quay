import { create } from 'zustand'
import { type ThemeColors, DEFAULT_THEME, applyTheme } from '../lib/theme'

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

/// 工具设置:侧栏「打开编辑器/终端」两个动作的目标。
/// editor = lib/launchers.ts EDITORS 的 key;终端默认起内置 zsh,可切外置 app。
export interface ToolsSettings {
  /** 默认编辑器(EDITORS key);决定侧栏图标 + open_with_app 用的 bundle id */
  editor: string
  /** 终端动作:internal=应用内 PTY 终端 / external=用外部终端 app 在该目录开会话 */
  terminalMode: 'internal' | 'external'
  /** 外置终端(TERMINALS key);仅 terminalMode='external' 时生效 */
  externalTerminal: string
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

const TOOLS_LS_KEY = 'quay.tools'
const TOOLS_DEFAULTS: ToolsSettings = {
  editor: 'vscode',
  terminalMode: 'internal',
  externalTerminal: 'terminal',
}

/// 外观设置:语义信号色覆盖。preset = 当前套用的预设 key('custom'=手动改过)。
export interface ThemeSettings {
  preset: string
  colors: ThemeColors
}

const THEME_LS_KEY = 'quay.theme'
const THEME_DEFAULTS: ThemeSettings = {
  preset: 'aurora',
  colors: DEFAULT_THEME,
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

function loadTools(): ToolsSettings {
  try {
    const raw = localStorage.getItem(TOOLS_LS_KEY)
    if (raw) return { ...TOOLS_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return TOOLS_DEFAULTS
}

function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(THEME_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // colors 也合并默认,防旧版缺字段
      return { ...THEME_DEFAULTS, ...parsed, colors: { ...DEFAULT_THEME, ...parsed.colors } }
    }
  } catch {
    /* ignore */
  }
  return THEME_DEFAULTS
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
  tools: ToolsSettings
  saveTools: (s: Partial<ToolsSettings>) => void
  theme: ThemeSettings
  saveTheme: (s: Partial<ThemeSettings>) => void
}

export const useSettings = create<SettingsStore>((set, get) => {
  const initial = load()
  const initialTheme = loadTheme()
  // 启动即把持久化的配色写到 :root(覆盖 index.css 默认)
  applyTheme(initialTheme.colors)
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
    tools: loadTools(),
    saveTools: (patch) => {
      const tools = { ...get().tools, ...patch }
      localStorage.setItem(TOOLS_LS_KEY, JSON.stringify(tools))
      set({ tools })
    },
    theme: initialTheme,
    saveTheme: (patch) => {
      const theme = { ...get().theme, ...patch }
      localStorage.setItem(THEME_LS_KEY, JSON.stringify(theme))
      applyTheme(theme.colors) // 立即生效
      set({ theme })
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
