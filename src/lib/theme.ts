/// 主题信号色:用户可在「设置 · 外观」编辑的 5 个语义色。
/// 衍生 token(--accent-soft/--ai-bg/--ai-border/--ai-text)在 index.css 用相对颜色语法
/// 从这 5 个派生,所以 applyTheme 只需覆盖这 5 个基础色,其余全自动级联。

export interface ThemeColors {
  /** 主强调 / 扫描 / 工具链识别 */
  accent: string
  /** AI / 智能 */
  ai: string
  /** 运行中 / 成功 */
  green: string
  /** 警告 / 冲突 */
  amber: string
  /** 危险 / 删除 */
  red: string
}

/// 默认「极光」——与 index.css :root 基础值一致(是其它预设和恢复默认的基准)。
export const DEFAULT_THEME: ThemeColors = {
  accent: '#38e8ff',
  ai: '#7c5cff',
  green: '#34e8a4',
  amber: '#fbbf24',
  red: '#ff6b6b',
}

/// 可编辑色的展示元信息(标签 + 语义说明),设置页逐行渲染。
export const THEME_COLOR_META: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: 'accent', label: '主色 / 扫描', hint: '强调色、工具链识别徽标、选中态' },
  { key: 'ai', label: 'AI / 智能', hint: 'AI 分组 / 识别 / 命令标记 / 解释' },
  { key: 'green', label: '运行中', hint: '运行中 / 成功状态' },
  { key: 'amber', label: '警告', hint: '端口冲突 / 警告提示' },
  { key: 'red', label: '危险', hint: '删除 / 错误' },
]

export interface ThemePreset {
  key: string
  name: string
  colors: ThemeColors
}

/// 预设调色板(一键套用整套)。默认极光始终在首位作基准。
export const THEME_PRESETS: ThemePreset[] = [
  { key: 'aurora', name: '极光', colors: DEFAULT_THEME },
  {
    key: 'neon',
    name: '霓虹紫',
    colors: { accent: '#22d3ee', ai: '#a855f7', green: '#34e8a4', amber: '#fbbf24', red: '#fb5d8b' },
  },
  {
    key: 'morandi',
    name: '莫兰迪',
    colors: { accent: '#8fb4c4', ai: '#a99bc9', green: '#8fc4a0', amber: '#d9b88f', red: '#cf9090' },
  },
  {
    key: 'warm',
    name: '暖阳',
    colors: { accent: '#ffb454', ai: '#c77dff', green: '#9ad36b', amber: '#ffd25c', red: '#ff7a6b' },
  },
]

/// 把 5 个基础色写到 :root(覆盖 index.css 默认);衍生 token 经相对颜色语法自动级联。
/// 在 store 初始化时 + 每次保存时调用。
export function applyTheme(c: ThemeColors): void {
  // store 初始化即调用 → 在 vitest(node)等无 DOM 环境会 ReferenceError。守卫后安全 no-op。
  if (typeof document === 'undefined') return
  const s = document.documentElement.style
  s.setProperty('--accent', c.accent)
  s.setProperty('--ai', c.ai)
  s.setProperty('--green', c.green)
  s.setProperty('--amber', c.amber)
  s.setProperty('--red', c.red)
}
