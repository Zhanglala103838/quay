// 字体注册表 + 应用助手。
// 英文(拉丁)字体定 metrics 在前,中文字体作 fallback 在后；xterm 固定网格渲染,
// 中文对齐由网格保证(不依赖字体 advance），故任意英文 + 任意中文都可自由组合。
// 打包字体的 @font-face 见 index.css；JetBrains/Bricolage 经 @fontsource(main.tsx)。

export type FontDef = { label: string; css: string }

/// 英文字体。css 为 font-family 片段(家族名已带引号)。
export const LATIN_FONTS: Record<string, FontDef> = {
  jetbrains: { label: 'JetBrains Mono', css: "'JetBrains Mono Variable'" },
  maple: { label: 'Maple Mono', css: "'Maple Mono'" },
  bricolage: { label: 'Bricolage', css: "'Bricolage Grotesque Variable'" },
  system: { label: '系统', css: "ui-monospace, 'SF Mono', Menlo, Monaco" },
}

/// 中文字体。
export const CJK_FONTS: Record<string, FontDef> = {
  pingfang: { label: '苹方(系统)', css: "'PingFang SC'" },
  sarasa: { label: 'Sarasa 更纱', css: "'Sarasa Mono SC'" },
  lxgw: { label: '霞鹜文楷', css: "'LXGW WenKai Mono'" },
}

/// 终端英文只给等宽款(Bricolage 是 UI 展示体,终端不列)。
export const TERM_LATIN_KEYS = ['jetbrains', 'maple', 'system'] as const
export const UI_LATIN_KEYS = ['jetbrains', 'maple', 'bricolage', 'system'] as const
export const CJK_KEYS = ['pingfang', 'sarasa', 'lxgw'] as const
export const FONT_SIZES = [11, 12, 13, 14, 15, 16] as const

const MONO_TAIL = "Menlo, Monaco, 'Courier New', monospace"
const UI_TAIL = '-apple-system, system-ui, sans-serif'

export function latinCss(key: string): string {
  return (LATIN_FONTS[key] ?? LATIN_FONTS.jetbrains).css
}
export function cjkCss(key: string): string {
  return (CJK_FONTS[key] ?? CJK_FONTS.pingfang).css
}

/// 终端字体栈:英文 → 中文 → 兜底等宽。
export function termStack(latin: string, cjk: string): string {
  return `${latinCss(latin)}, ${cjkCss(cjk)}, ${MONO_TAIL}`
}

/// 设置 UI 字体 CSS 变量(覆盖 index.css @theme 默认):
/// body / 多数 UI 走 --font-mono;品牌标题 --font-display 保留 Bricolage,仅中文跟随选择。
export function applyUiFontVars(latin: string, cjk: string): void {
  const root = document.documentElement
  root.style.setProperty('--font-mono', `${latinCss(latin)}, ${cjkCss(cjk)}, ${MONO_TAIL}`)
  root.style.setProperty(
    '--font-display',
    `'Bricolage Grotesque Variable', ${cjkCss(cjk)}, ${UI_TAIL}`,
  )
}

/// 强制预加载字体栈里的具名家族(xterm 需字体就绪后才量对字宽,否则首帧用回退字体量错列)。
export function ensureFontsLoaded(stack: string, sizePx: number): Promise<unknown> {
  if (!document.fonts) return Promise.resolve()
  const fams = stack.match(/'[^']+'/g) ?? []
  return Promise.all(fams.map((f) => document.fonts.load(`${sizePx}px ${f}`).catch(() => {})))
}
