import { useEffect, useRef } from 'react'

/// 侧栏↔工作区宽度拖拽手柄。
/// 拖拽期间直接改 :root 的 --sidebar-w(不走 React state),避免每帧重渲染卡顿;
/// 松手才落 localStorage。.sidebar 用 width: var(--sidebar-w, 292px) 读取。
///
/// 拖动期间在 <html> 挂 .resizing:① 关掉 .sidebar 的 width 过渡(否则每步补间→橡皮筋卡顿);
/// ② 让终端 ResizeObserver 跳过 fit(否则每帧 fit×多格+WebGL→卡)。松手派发 quay:resize-end,
/// 终端据此统一 fit 一次。
const LS = 'quay.sidebarW'
const MIN = 270 // 保证 8 字项目名 + 操作 chips(+目录/+命令/✕)一行放得下、不换行
const MAX = 560
const DEFAULT = 292
const COLLAPSE_AT = 170 // 继续往左拖超过此宽度 → 自动折叠

export function Resizer({
  collapsed,
  onCollapse,
}: {
  collapsed?: boolean
  onCollapse?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const saved = Number(localStorage.getItem(LS))
    const w = saved >= MIN && saved <= MAX ? saved : DEFAULT
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
  }, [])

  // 展开(非折叠态)时兜底:--sidebar-w 至少为 MIN,保证从折叠/拖窄展回不会比最小宽度还窄。
  useEffect(() => {
    if (collapsed) return
    const cur =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 0
    if (cur < MIN) {
      document.documentElement.style.setProperty('--sidebar-w', `${MIN}px`)
      localStorage.setItem(LS, String(MIN))
    }
  }, [collapsed])

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) ||
      DEFAULT
    ref.current?.classList.add('dragging')
    document.documentElement.classList.add('resizing')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    let ended = false
    let rafId = 0
    let pendingX = startX
    const cleanup = () => {
      if (ended) return
      ended = true
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      ref.current?.classList.remove('dragging')
      document.documentElement.classList.remove('resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // 松手后终端统一 fit 一次(拖动期间被跳过)
      window.dispatchEvent(new Event('quay:resize-end'))
    }

    // rAF 节流:mousemove 可能 >60/s,合并到每帧一次写 --sidebar-w,避免一帧多次样式/布局重算。
    const apply = () => {
      rafId = 0
      const raw = startW + (pendingX - startX)
      // 拖得比阈值还窄 → 自动折叠(--sidebar-w 停在 MIN,展开即恢复正常宽度)
      if (onCollapse && raw < COLLAPSE_AT) {
        onCollapse()
        cleanup()
        return
      }
      const w = Math.max(MIN, Math.min(MAX, raw))
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
    }
    const onMove = (ev: MouseEvent) => {
      pendingX = ev.clientX
      if (!rafId) rafId = requestAnimationFrame(apply)
    }
    const onUp = () => {
      const final = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
      )
      if (final) localStorage.setItem(LS, String(Math.round(final)))
      cleanup()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return <div ref={ref} className="resizer" onMouseDown={onMouseDown} aria-label="拖动调整侧栏宽度" />
}
