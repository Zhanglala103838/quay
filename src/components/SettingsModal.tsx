import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings, DEEPSEEK_MODELS, type DeepSeekSettings } from '../state/settings'
import { testConnection } from '../lib/deepseek'
import { BorderBeam } from './ui/BorderBeam'
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
  { id: 'fonts', label: '字体' },
  { id: 'render', label: '渲染' },
  { id: 'debug', label: '调试' },
] as const
type TabId = (typeof TABS)[number]['id']

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { deepseek, save, render, saveRender, debug, saveDebug } = useSettings()
  const [form, setForm] = useState<DeepSeekSettings>(deepseek)
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
    fonts: null,
    render: null,
    debug: null,
  })
  // 点 tab 触发平滑滚动期间锁住 scrollspy,避免途经分区时 active 来回跳。
  const lockUntil = useRef(0)

  const set = (k: keyof DeepSeekSettings, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setResult(null)
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
