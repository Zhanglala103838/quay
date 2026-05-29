import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../state/settings'
import { openDevtools } from '../lib/ipc'

/// 全局自绘右键菜单:拦 contextmenu(preventDefault 掉系统/WebView 默认菜单),按光标位置弹出。
/// 默认仅「重新加载」(location.reload());设置开启「调试能力」后追加「检查元素」(调后端 open_devtools)。
/// 不依赖 Tauri 原生菜单,纯 DOM,便于贴合玻璃设计系统。
interface Pos {
  x: number
  y: number
}

interface Item {
  label: string
  icon: string
  onClick: () => void
}

export function ContextMenu() {
  const debugOn = useSettings((s) => s.debug.enabled)
  const [pos, setPos] = useState<Pos | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 拦截全局右键:阻止默认,记录光标位置并打开。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setPos({ x: e.clientX, y: e.clientY })
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // 打开后:任意 mousedown(命中外部)/Esc/滚动/失焦/再次右键 都关闭。
  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // 用 capture 抓 mousedown,确保点菜单项也先经 onClick;命中菜单内部时不关。
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [pos])

  // 弹出后按菜单实际尺寸夹紧到视口内(避免贴边溢出)。
  useLayoutEffect(() => {
    if (!pos || !menuRef.current) return
    const r = menuRef.current.getBoundingClientRect()
    const pad = 8
    let { x, y } = pos
    if (x + r.width > window.innerWidth - pad) x = window.innerWidth - r.width - pad
    if (y + r.height > window.innerHeight - pad) y = window.innerHeight - r.height - pad
    if (x !== pos.x || y !== pos.y) setPos({ x: Math.max(pad, x), y: Math.max(pad, y) })
    // 仅在打开瞬间夹紧,故依赖整个 pos 对象不会无限循环(夹紧后值收敛)。
  }, [pos])

  if (!pos) return null

  const items: Item[] = [
    { label: '重新加载', icon: '↻', onClick: () => location.reload() },
  ]
  if (debugOn) {
    items.push({ label: '检查元素', icon: '⧉', onClick: () => openDevtools() })
  }

  return createPortal(
    <div
      ref={menuRef}
      className="ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="ctxmenu-item"
          onClick={() => {
            setPos(null)
            it.onClick()
          }}
        >
          <span className="ctxmenu-icon">{it.icon}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
