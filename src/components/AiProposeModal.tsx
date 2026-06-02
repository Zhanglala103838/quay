import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'
import type { Proposal } from '../lib/types'

interface Row extends Proposal {
  checked: boolean
  editing: boolean
  exists: boolean
}

/// AI 提议命令的确认清单:勾选 + 内联编辑 + why。落地选中项。
/// isExisting:判断该提议是否已存在于本地命令(同 命令+目录),已存在的标「已添加」且默认不勾选。
export function AiProposeModal({
  proposals,
  isExisting,
  onConfirm,
  onCancel,
}: {
  proposals: Proposal[]
  isExisting?: (p: Proposal) => boolean
  onConfirm: (selected: Proposal[]) => void
  onCancel: () => void
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    proposals.map((p) => {
      const exists = isExisting?.(p) ?? false
      return { ...p, checked: !exists, editing: false, exists }
    }),
  )
  const patch = (i: number, d: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...d } : r)))
  const selected = rows.filter((r) => r.checked && r.name.trim() && r.command.trim())
  const existCount = rows.filter((r) => r.exists).length

  return createPortal(
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box ai-propose" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>✨ AI 识别到 {proposals.length} 条可运行命令</h3>
        {proposals.length === 0 && (
          <div className="ai-empty">AI 未能从该项目推断出可运行命令。</div>
        )}
        {existCount > 0 && (
          <div className="ai-exist-note">其中 {existCount} 条本地已存在,已默认不勾选。</div>
        )}
        <div className="ai-propose-list">
          {rows.map((r, i) => (
            <div className={'ai-row' + (r.checked ? '' : ' off')} key={i}>
              <label className="ai-row-head">
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => patch(i, { checked: e.target.checked })}
                />
                {r.editing ? (
                  <input
                    className="ai-edit"
                    value={r.name}
                    placeholder="标签"
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                ) : (
                  <span className="ai-row-name">{r.name}</span>
                )}
                {r.exists && <span className="ai-row-exist">已添加</span>}
                <button
                  type="button"
                  className="ai-edit-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    patch(i, { editing: !r.editing })
                  }}
                >
                  {r.editing ? '完成' : '✎'}
                </button>
              </label>
              {r.editing ? (
                <div className="ai-edit-fields">
                  <input
                    className="ai-edit"
                    value={r.command}
                    placeholder="命令"
                    onChange={(e) => patch(i, { command: e.target.value })}
                  />
                  <input
                    className="ai-edit"
                    value={r.cwd}
                    placeholder="cwd（相对根，空=根目录）"
                    onChange={(e) => patch(i, { cwd: e.target.value })}
                  />
                </div>
              ) : (
                <div className="ai-row-cmd">
                  <code>{r.command}</code>
                  <span className="ai-row-cwd">
                    <span className="ai-cwd-icon" aria-hidden="true">📁</span>
                    运行于 {r.cwd || '项目根目录'}
                  </span>
                </div>
              )}
              {r.why && <div className="ai-row-why">为什么：{r.why}</div>}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button
            className="modal-btn primary"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected.map(({ name, command, cwd, why }) => ({ name, command, cwd, why })))}
          >
            落地选中 {selected.length} 条
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
