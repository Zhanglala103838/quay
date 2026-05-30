import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'
import { pickDirectory } from '../lib/ipc'

export interface Field {
  key: string
  label: string
  placeholder?: string
  initial?: string
  /// 提供 datalist 快速选择项(仍可自定义输入)。
  options?: string[]
  /// 未手动编辑前,镜像另一字段的值(如 标签 自动跟随 命令)。一旦手改即解除。
  mirrorOf?: string
  /// 最大输入字符数(如项目名限 6 字)。
  maxLength?: number
  /// 在输入框旁加「选择目录」按钮,拉起原生 Finder 选文件夹(仍可手输)。
  pickDir?: boolean
}

/// 应用内输入弹窗。替代 window.prompt —— 后者在 Tauri WKWebView 不工作。
export function InputModal({
  title,
  fields,
  onSubmit,
  onCancel,
}: {
  title: string
  fields: Field[]
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  )
  // 已被用户手动编辑过的字段(镜像字段一旦手改就解除跟随)。
  // 带 initial 值的字段(如编辑场景预填的标签)视为已脏,免得镜像源覆盖掉它本身的值。
  const [dirty, setDirty] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(fields.filter((f) => f.initial != null).map((f) => [f.key, true])),
  )
  const firstRef = useRef<HTMLInputElement>(null)
  // 正在用输入法合成(打拼音/假名)的字段 key。合成期间不按 maxLength 截断,
  // 否则中间态拼音字母会占满名额、字还没上屏就被挡住。
  const composingKey = useRef<string | null>(null)

  // 按「字符数」(Array.from 正确数 emoji/CJK)截到 maxLength;无 maxLength 原样返回。
  const clamp = (f: Field, v: string) =>
    f.maxLength ? Array.from(v).slice(0, f.maxLength).join('') : v

  // 「选择目录」:拉起原生 Finder,选中后填入(取消则不动)。
  const pick = async (f: Field) => {
    const p = await pickDirectory()
    if (!p) return
    setDirty((d) => ({ ...d, [f.key]: true }))
    setValues((vs) => ({ ...vs, [f.key]: p }))
  }

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  // 字段当前展示值:镜像字段未手改前跟随源字段
  const shown = (f: Field) =>
    f.mirrorOf && !dirty[f.key] ? (values[f.mirrorOf] ?? '') : (values[f.key] ?? '')

  const submit = () => {
    // 至少第一个字段非空才提交
    if (!shown(fields[0]).trim()) return
    // 提交时把镜像字段的展示值固化进结果
    const out: Record<string, string> = {}
    for (const f of fields) out[f.key] = shown(f)
    onSubmit(out)
  }

  // 必须 portal 到 body：祖先(.sidebar)的 backdrop-filter 会成为 fixed 定位的包含块，
  // 否则弹窗被困在侧栏内而非全屏居中。
  return createPortal(
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>{title}</h3>
        {fields.map((f, i) => (
          <div key={f.key} className="field">
            <label>{f.label}</label>
            <div className="field-input-row">
            <input
              ref={i === 0 ? firstRef : undefined}
              value={shown(f)}
              placeholder={f.placeholder}
              list={f.options?.length ? `dl-${f.key}` : undefined}
              onCompositionStart={() => {
                composingKey.current = f.key
              }}
              onCompositionEnd={(e) => {
                composingKey.current = null
                // 合成结束(字已上屏)再按字数截断这一次的最终值。
                const v = clamp(f, e.currentTarget.value)
                setDirty((d) => ({ ...d, [f.key]: true }))
                setValues((vs) => ({ ...vs, [f.key]: v }))
              }}
              onChange={(e) => {
                // 合成中:原样存(不截断、也不改变受控 value,免得打断输入法);
                // 普通输入/合成结束后的 change:按字数截断。
                const composing = composingKey.current === f.key
                const v = composing ? e.target.value : clamp(f, e.target.value)
                setDirty((d) => ({ ...d, [f.key]: true }))
                setValues((vs) => ({ ...vs, [f.key]: v }))
              }}
              onKeyDown={(e) => {
                // 不绑 Enter 提交:Enter 全交给输入法(确认候选词)/换行,提交只走「确定」按钮,
                // 彻底避免输入法确认时误触发提交。仅保留 Esc 取消;合成中的 Esc 归输入法、不关弹窗。
                if (e.nativeEvent.isComposing || composingKey.current === f.key) return
                if (e.key === 'Escape') onCancel()
              }}
            />
            {f.pickDir ? (
              <button type="button" className="field-pick-btn" onClick={() => pick(f)}>
                选择目录
              </button>
            ) : null}
            </div>
            {f.options?.length ? (
              <datalist id={`dl-${f.key}`}>
                {f.options.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            ) : null}
            {/* 快速选择 chips:点一下填入,仍可手改 */}
            {f.options?.length ? (
              <div className="field-chips">
                {f.options.map((o) => (
                  <button
                    type="button"
                    key={o}
                    className="field-chip"
                    onClick={() => setValues((v) => ({ ...v, [f.key]: o }))}
                  >
                    {o.split('/').filter(Boolean).pop() || o}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <div className="modal-actions">
          <button className="modal-btn primary" onClick={submit}>
            确定
          </button>
          <button className="modal-btn ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
