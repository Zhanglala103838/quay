import { createPortal } from 'react-dom'
import { useConfirm } from '../state/confirm'

/// 全局确认弹窗(用应用内 UI,不用 window.confirm —— 后者在 Tauri WKWebView 失效)。
/// portal 到 body,避免祖先 backdrop-filter 困住 fixed 居中。
export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending)
  const close = useConfirm((s) => s.close)
  if (!pending) return null

  return createPortal(
    <div className="modal" onMouseDown={close}>
      <div className="modal-box confirm-box" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{pending.title}</h3>
        {pending.message && <p className="modal-sub">{pending.message}</p>}
        <div className="modal-actions">
          <button
            className="modal-btn danger"
            onClick={() => {
              pending.onConfirm()
              close()
            }}
          >
            {pending.confirmText ?? '确定'}
          </button>
          <button className="modal-btn ghost" onClick={close}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
