import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings, DEEPSEEK_MODELS, type DeepSeekSettings } from '../state/settings'
import { testConnection } from '../lib/deepseek'
import { detectApps } from '../lib/ipc'
import { editorsForPlatform, terminalsForPlatform, isInstalled, probeIds } from '../lib/launchers'
import { EditorIcon, TerminalIcon } from './AppIcons'
import { BorderBeam } from './ui/BorderBeam'
import { ColorField, parseColor } from '@heroui/react'
import {
  THEME_PRESETS,
  THEME_COLOR_META,
  DEFAULT_THEME,
  type ThemeColors,
} from '../lib/theme'
import {
  LATIN_FONTS,
  CJK_FONTS,
  TERM_LATIN_KEYS,
  UI_LATIN_KEYS,
  CJK_KEYS,
  FONT_SIZES,
  type FontDef,
} from '../lib/fonts'

/// 字体 chip 组:每个 chip 用自身字体渲染标签(中文 chip 直接预览该中文字体)。
function FontChips({
  keys,
  reg,
  value,
  onPick,
}: {
  keys: readonly string[]
  reg: Record<string, FontDef>
  value: string
  onPick: (k: string) => void
}) {
  return (
    <div className="field-chips">
      {keys.map((k) => (
        <button
          type="button"
          key={k}
          className={'field-chip' + (value === k ? ' active' : '')}
          style={{ fontFamily: reg[k].css }}
          onClick={() => onPick(k)}
        >
          {reg[k].label}
        </button>
      ))}
    </div>
  )
}

/// 设置弹窗:固定高度 + 左侧 tab 导航 + 右侧滚动内容。
/// 点 tab → 平滑滚到对应分区;滚动时 scrollspy 高亮当前 tab(含滚到底部高亮末项)。
const TABS = [
  { id: 'ai', label: '智能能力' },
  { id: 'tools', label: '工具' },
  { id: 'fonts', label: '字体' },
  { id: 'theme', label: '外观' },
  { id: 'render', label: '渲染' },
  { id: 'debug', label: '调试' },
] as const
type TabId = (typeof TABS)[number]['id']

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { deepseek, save, render, saveRender, debug, saveDebug, tools, saveTools, theme, saveTheme } =
    useSettings()
  const [form, setForm] = useState<DeepSeekSettings>(deepseek)
  const [editor, setEditor] = useState(tools.editor)
  const [termMode, setTermMode] = useState(tools.terminalMode)
  const [extTerm, setExtTerm] = useState(tools.externalTerminal)
  // 已安装的 bundle id 集合(扫描结果);未装的启动器置灰但仍可选。
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [gpu, setGpu] = useState(render.gpuAcceleration)
  const [termLatin, setTermLatin] = useState(render.termLatin)
  const [termCJK, setTermCJK] = useState(render.termCJK)
  const [termSize, setTermSize] = useState(render.termFontSize)
  const [uiLatin, setUiLatin] = useState(render.uiLatin)
  const [uiCJK, setUiCJK] = useState(render.uiCJK)
  const [debugOn, setDebugOn] = useState(debug.enabled)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [active, setActive] = useState<TabId>('ai')
  const contentRef = useRef<HTMLDivElement>(null)
  const paneRefs = useRef<Record<TabId, HTMLElement | null>>({
    ai: null,
    tools: null,
    fonts: null,
    theme: null,
    render: null,
    debug: null,
  })
  // 点 tab 触发平滑滚动期间锁住 scrollspy,避免途经分区时 active 来回跳。
  const lockUntil = useRef(0)

  const set = (k: keyof DeepSeekSettings, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setResult(null)
  }

  // 配色实时生效:改单色即标记为 custom 并立刻 saveTheme(应用 + 持久化)。
  const setColor = (k: keyof ThemeColors, hex: string) =>
    saveTheme({ preset: 'custom', colors: { ...theme.colors, [k]: hex } })
  const safeParse = (hex: string) => {
    try {
      return parseColor(hex)
    } catch {
      return null
    }
  }

  const doSave = () => {
    save(form)
    saveRender({
      gpuAcceleration: gpu,
      termLatin,
      termCJK,
      termFontSize: termSize,
      uiLatin,
      uiCJK,
    })
    saveDebug({ enabled: debugOn })
    saveTools({ editor, terminalMode: termMode, externalTerminal: extTerm })
    onClose()
  }

  const doTest = async () => {
    save(form) // 用当前输入测试
    setTesting(true)
    setResult(null)
    setResult(await testConnection())
    setTesting(false)
  }

  const goto = (id: TabId) => {
    setActive(id)
    lockUntil.current = Date.now() + 500
    paneRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // scrollspy:取「顶端阈值线」上方最后一个分区为当前;滚到底部则强制末项。
  const onScroll = () => {
    if (Date.now() < lockUntil.current) return
    const root = contentRef.current
    if (!root) return
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
      setActive(TABS[TABS.length - 1].id)
      return
    }
    let cur: TabId = TABS[0].id
    for (const t of TABS) {
      const el = paneRefs.current[t.id]
      if (el && el.offsetTop <= root.scrollTop + 24) cur = t.id
    }
    setActive(cur)
  }

  // 打开设置时扫描本机已装的编辑器/终端(走 LaunchServices,不依赖 Spotlight)。
  useEffect(() => {
    const ids = [...editorsForPlatform(), ...terminalsForPlatform()].flatMap(probeIds)
    detectApps(ids)
      .then((found) => setInstalled(new Set(found)))
      .catch(() => {})
  }, [])

  // Esc 关弹窗(与右键菜单一致的交互直觉)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal" onMouseDown={onClose}>
      <div className="modal-box settings-box" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <div className="settings-head">
          <h3>⚙️ 设置</h3>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={'settings-nav-tab' + (active === t.id ? ' active' : '')}
                onClick={() => goto(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content" ref={contentRef} onScroll={onScroll}>
            {/* ── 智能能力 ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.ai = el }}>
              <div className="settings-section-label">DeepSeek · 智能能力</div>
              <p className="modal-sub">
                配置 DeepSeek 后，可对命令做「智能分组」与「用途解释」。Key 仅存本机 localStorage，不上传。
              </p>

              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.apiKey}
                  placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => set('apiKey', e.target.value)}
                />
              </div>

              <div className="field">
                <label>模型</label>
                <input
                  value={form.model}
                  placeholder="deepseek-chat"
                  list="dl-ds-model"
                  onChange={(e) => set('model', e.target.value)}
                />
                <datalist id="dl-ds-model">
                  {DEEPSEEK_MODELS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <div className="field-chips">
                  {DEEPSEEK_MODELS.map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={'field-chip' + (form.model === m ? ' active' : '')}
                      onClick={() => set('model', m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Base URL</label>
                <input
                  value={form.baseUrl}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => set('baseUrl', e.target.value)}
                />
              </div>

              {/* 测试连接归属 DeepSeek 配置块:验证当前 key/model/baseUrl 是否可用 */}
              <div className="settings-test-row">
                <button className="modal-btn accent" disabled={testing} onClick={doTest}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
              </div>
              {result && (
                <div className={'test-result ' + (result.ok ? 'ok' : 'err')}>{result.message}</div>
              )}
            </section>

            {/* ── 工具(编辑器 / 终端) ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.tools = el }}>
              <div className="settings-section-label">默认编辑器</div>
              <p className="modal-sub">
                侧栏目录的「打开编辑器」按钮用它打开目录,按钮图标随所选变化。标「未装」的为本机未检测到,选中后点开会提示。
              </p>
              <div className="field">
                <div className="field-chips">
                  {editorsForPlatform().map((e) => {
                    const ok = isInstalled(e, installed)
                    return (
                      <button
                        type="button"
                        key={e.key}
                        className={
                          'field-chip launcher-chip' +
                          (editor === e.key ? ' active' : '') +
                          (ok ? '' : ' missing')
                        }
                        onClick={() => setEditor(e.key)}
                      >
                        <EditorIcon editorKey={e.key} size={13} />
                        <span>{e.label}</span>
                        {!ok && <span className="launcher-missing">未装</span>}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="settings-divider" />
              <div className="settings-section-label">终端</div>
              <p className="modal-sub">
                「打开终端」按钮起应用内置终端,还是用外部终端 app 在该目录开会话。
              </p>
              <div className="field">
                <div className="field-chips">
                  <button
                    type="button"
                    className={'field-chip' + (termMode === 'internal' ? ' active' : '')}
                    onClick={() => setTermMode('internal')}
                  >
                    内置终端
                  </button>
                  <button
                    type="button"
                    className={'field-chip' + (termMode === 'external' ? ' active' : '')}
                    onClick={() => setTermMode('external')}
                  >
                    外置终端
                  </button>
                </div>
              </div>
              {termMode === 'external' && (
                <div className="field">
                  <label>外置终端</label>
                  <div className="field-chips">
                    {terminalsForPlatform().map((t) => {
                      const ok = isInstalled(t, installed)
                      return (
                        <button
                          type="button"
                          key={t.key}
                          className={
                            'field-chip launcher-chip' +
                            (extTerm === t.key ? ' active' : '') +
                            (ok ? '' : ' missing')
                          }
                          onClick={() => setExtTerm(t.key)}
                        >
                          <TerminalIcon termKey={t.key} size={13} />
                          <span>{t.label}</span>
                          {!ok && <span className="launcher-missing">未装</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* ── 字体(终端 + 界面) ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.fonts = el }}>
              <div className="settings-section-label">终端字体</div>
              <div className="field">
                <label>英文</label>
                <FontChips keys={TERM_LATIN_KEYS} reg={LATIN_FONTS} value={termLatin} onPick={setTermLatin} />
              </div>
              <div className="field">
                <label>中文</label>
                <FontChips keys={CJK_KEYS} reg={CJK_FONTS} value={termCJK} onPick={setTermCJK} />
              </div>
              <div className="field">
                <label>字号</label>
                <div className="field-chips">
                  {FONT_SIZES.map((s) => (
                    <button
                      type="button"
                      key={s}
                      className={'field-chip' + (termSize === s ? ' active' : '')}
                      onClick={() => setTermSize(s)}
                    >
                      {s}px
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-divider" />
              <div className="settings-section-label">界面字体(非终端)</div>
              <div className="field">
                <label>英文</label>
                <FontChips keys={UI_LATIN_KEYS} reg={LATIN_FONTS} value={uiLatin} onPick={setUiLatin} />
              </div>
              <div className="field">
                <label>中文</label>
                <FontChips keys={CJK_KEYS} reg={CJK_FONTS} value={uiCJK} onPick={setUiCJK} />
              </div>
            </section>

            {/* ── 外观 · 配色 ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.theme = el }}>
              <div className="settings-section-label">外观 · 配色</div>
              <p className="modal-sub">
                选一套预设,或逐色微调。改动实时生效并保存。配色按语义统一——一种语义一种色,跨场景不复用。
              </p>

              <div className="field">
                <label>预设主题</label>
                <div className="theme-presets">
                  {THEME_PRESETS.map((p) => (
                    <button
                      type="button"
                      key={p.key}
                      className={'theme-preset' + (theme.preset === p.key ? ' active' : '')}
                      onClick={() => saveTheme({ preset: p.key, colors: p.colors })}
                    >
                      <span className="theme-preset-dots">
                        {(['accent', 'ai', 'green', 'amber', 'red'] as (keyof ThemeColors)[]).map(
                          (k) => (
                            <i key={k} style={{ background: p.colors[k] }} />
                          ),
                        )}
                      </span>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>逐色微调</label>
                <div className="theme-colors">
                  {THEME_COLOR_META.map((m) => {
                    const hex = theme.colors[m.key]
                    return (
                      <div className="theme-color-row" key={m.key}>
                        <label className="theme-swatch" style={{ background: hex }} title="点选颜色">
                          <input
                            type="color"
                            value={hex}
                            onChange={(e) => setColor(m.key, e.target.value)}
                          />
                        </label>
                        <div className="theme-color-meta">
                          <span className="theme-color-label">{m.label}</span>
                          <span className="theme-color-hint">{m.hint}</span>
                        </div>
                        <ColorField
                          aria-label={m.label}
                          value={safeParse(hex)}
                          onChange={(c) => c && setColor(m.key, c.toString('hex'))}
                        >
                          <ColorField.Group className="theme-hex-group">
                            <ColorField.Input className="theme-hex-input" />
                          </ColorField.Group>
                        </ColorField>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="settings-test-row">
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => saveTheme({ preset: 'aurora', colors: DEFAULT_THEME })}
                >
                  恢复默认(极光)
                </button>
              </div>
            </section>

            {/* ── 渲染 ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.render = el }}>
              <div className="settings-section-label">渲染</div>
              <button
                type="button"
                className="toggle-row"
                role="switch"
                aria-checked={gpu}
                onClick={() => setGpu((v) => !v)}
              >
                <div className="toggle-row-text">
                  <div className="toggle-row-title">GPU 渲染加速</div>
                  <div className="toggle-row-desc">
                    {gpu
                      ? '激活终端用 WebGL（GPU）渲染，大量输出更流畅'
                      : '已关闭，退回 DOM 渲染（纯 CPU，更省电/更兼容，海量输出时偏卡）'}
                  </div>
                </div>
                <span className={'switch' + (gpu ? ' on' : '')}>
                  <span className="switch-knob" />
                </span>
              </button>
            </section>

            {/* ── 调试 ── */}
            <section className="settings-pane" ref={(el) => { paneRefs.current.debug = el }}>
              <div className="settings-section-label">调试</div>
              <button
                type="button"
                className="toggle-row"
                role="switch"
                aria-checked={debugOn}
                onClick={() => setDebugOn((v) => !v)}
              >
                <div className="toggle-row-text">
                  <div className="toggle-row-title">开启调试能力</div>
                  <div className="toggle-row-desc">
                    {debugOn
                      ? '右键菜单将出现「检查元素」，可打开开发者工具排查界面问题'
                      : '已关闭，右键菜单仅保留「重新加载」'}
                  </div>
                </div>
                <span className={'switch' + (debugOn ? ' on' : '')}>
                  <span className="switch-knob" />
                </span>
              </button>
            </section>
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn primary" onClick={doSave}>
            保存
          </button>
          <button className="modal-btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
