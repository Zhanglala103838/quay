import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'
import type { ProjectContext } from '../lib/types'

interface FileRow {
  relPath: string
  content: string
  truncated: boolean
  checked: boolean
  expanded: boolean
}

/// 真实 UTF-8 字节数(与 Rust 端按字节截断一致;CJK 字符数≠字节数,直接用 .length 会少报)。
function byteLen(s: string) {
  return new TextEncoder().encode(s).length
}
function fmtSize(n: number) {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`
}

/// 发送前确认:列出将发给 DeepSeek 的文件,默认全选,可逐个勾掉、可展开看将发送的实际内容。
/// 确认后只把勾选的文件交给 proposeCommands;目录结构(仅路径名)一并发送。
export function AiContextModal({
  context,
  onConfirm,
  onCancel,
}: {
  context: ProjectContext
  onConfirm: (selectedRelPaths: string[]) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<FileRow[]>(() =>
    context.files.map((f) => ({ ...f, checked: true, expanded: false })),
  )
  const patch = (i: number, d: Partial<FileRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...d } : r)))
  const selected = rows.filter((r) => r.checked)

  return createPortal(
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box ai-context" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>✨ AI 识别 · 将发送以下文件给 DeepSeek</h3>
        <div className="ai-ctx-note">仅配置/清单类文件,不含源码;.env / 密钥 / 凭证已自动排除。</div>
        {context.files.length === 0 ? (
          <div className="ai-empty">未采集到可发送的配置文件(仅目录结构可供识别)。</div>
        ) : (
          <div className="ai-ctx-list">
            {rows.map((r, i) => (
              <div className={'ai-ctx-row' + (r.checked ? '' : ' off')} key={r.relPath}>
                <label className="ai-ctx-head">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={(e) => patch(i, { checked: e.target.checked })}
                  />
                  <span className="ai-ctx-path">{r.relPath}</span>
                  <span className="ai-ctx-size">
                    {fmtSize(byteLen(r.content))}
                    {r.truncated ? ' · 已截断' : ''}
                  </span>
                  <button
                    type="button"
                    className="ai-ctx-toggle"
                    onClick={(e) => {
                      e.preventDefault()
                      patch(i, { expanded: !r.expanded })
                    }}
                  >
                    {r.expanded ? '▾ 收起' : '▸ 看'}
                  </button>
                </label>
                {r.expanded && <pre className="ai-ctx-content">{r.content}</pre>}
              </div>
            ))}
          </div>
        )}
        <div className="ai-ctx-foot">目录结构(仅路径名)也会一并发送给 DeepSeek。</div>
        <div className="modal-actions">
          <button
            className="modal-btn primary"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected.map((r) => r.relPath))}
          >
            开始识别（已选 {selected.length}）
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
