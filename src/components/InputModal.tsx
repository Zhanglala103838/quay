import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'

export interface Field {
  key: string
  label: string
  placeholder?: string
  initial?: string
  /// 提供 datalist 快速选择项(仍可自定义输入)。
  options?: string[]
  /// 未手动编辑前,镜像另一字段的值(如 标签 自动跟随 命令)。一旦手改即解除。
  mirrorOf?: string
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
  // 已被用户手动编辑过的字段(镜像字段一旦手改就解除跟随)
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const firstRef = useRef<HTMLInputElement>(null)

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
            <input
              ref={i === 0 ? firstRef : undefined}
              value={shown(f)}
              placeholder={f.placeholder}
              list={f.options?.length ? `dl-${f.key}` : undefined}
              onChange={(e) => {
                setDirty((d) => ({ ...d, [f.key]: true }))
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
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
