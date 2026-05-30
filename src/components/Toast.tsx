import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useToast } from '../state/toast'

/// 轻量浮层提示(底部居中),~2.2s 自动消失。portal 到 body,避开祖先 backdrop-filter。
/// 用 seq 作 key 重启进入动画 + 计时,连续弹也能续命。
export function Toast() {
  const msg = useToast((s) => s.msg)
  const seq = useToast((s) => s.seq)
  const clear = useToast((s) => s.clear)

  useEffect(() => {
    if (!msg) return
    const t = setTimeout(clear, 2200)
    return () => clearTimeout(t)
  }, [seq, msg, clear])

  if (!msg) return null

  return createPortal(
    <div className="toast" key={seq}>
      {msg}
    </div>,
    document.body,
  )
}
