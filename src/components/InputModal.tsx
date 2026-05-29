import { useEffect, useRef, useState } from 'react'

export interface Field {
  key: string
  label: string
  placeholder?: string
  initial?: string
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
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstRef.current?.focus()
  }, [])

  const submit = () => {
    // 至少第一个字段非空才提交
    if (!values[fields[0].key]?.trim()) return
    onSubmit(values)
  }

  return (
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {fields.map((f, i) => (
          <div key={f.key} className="field">
            <label>{f.label}</label>
            <input
              ref={i === 0 ? firstRef : undefined}
              value={values[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
          </div>
        ))}
        <div className="modal-actions">
          <button className="primary" onClick={submit}>
            确定
          </button>
          <button onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
