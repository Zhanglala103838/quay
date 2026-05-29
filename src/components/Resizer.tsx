import { useEffect, useRef } from 'react'

/// 侧栏↔工作区宽度拖拽手柄。
/// 拖拽期间直接改 :root 的 --sidebar-w(不走 React state),避免每帧重渲染卡顿;
/// 松手才落 localStorage。.sidebar 用 width: var(--sidebar-w, 292px) 读取。
const LS = 'quay.sidebarW'
const MIN = 220
const MAX = 560
const DEFAULT = 292

export function Resizer() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const saved = Number(localStorage.getItem(LS))
    const w = saved >= MIN && saved <= MAX ? saved : DEFAULT
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) ||
      DEFAULT
    ref.current?.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN, Math.min(MAX, startW + (ev.clientX - startX)))
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      ref.current?.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const final = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
      )
      if (final) localStorage.setItem(LS, String(Math.round(final)))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return <div ref={ref} className="resizer" onMouseDown={onMouseDown} aria-label="拖动调整侧栏宽度" />
}
