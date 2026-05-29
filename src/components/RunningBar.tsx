import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { runsMemory } from '../lib/ipc'
import type { MemReport } from '../lib/types'
import { NumberTicker } from './ui/NumberTicker'

/// 字节 → 人类可读(MB / GB)。0 / 未知显示 —。
function fmtMem(b: number): string {
  if (!b) return '—'
  const mb = b / 1048576
  return mb < 1000 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`
}

const VISIBLE = 2 // 直接铺在 bar 上的 chip 数,其余折叠进 +N

export function RunningBar() {
  // selector 必须返回稳定引用,否则 zustand v5 会判定每次都变 → 无限重渲染。
  // 取 s.runs(引用稳定),在组件体内 filter。
  const runs = useStore((s) => s.runs)
  const running = runs.filter((r) => r.status === 'running')

  // 内存:有命令在跑时 ~2s 轮询;全退出就停,不空转。
  const [mem, setMem] = useState<MemReport | null>(null)
  const runningKey = running.map((r) => r.runId).join(',')
  useEffect(() => {
    if (!runningKey) return // 无 running 不轮询;mem 保留但下方按 running.length 不渲染
    let alive = true
    const tick = () =>
      runsMemory()
        .then((m) => alive && setMem(m))
        .catch(() => {})
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [runningKey])
  const memOf = (runId: string) => fmtMem(mem?.runs.find((s) => s.runId === runId)?.memBytes ?? 0)
  // 「全局」= Quay 主进程 + 所有在跑命令的进程树之和(故必 ≥ 任何单条命令)。
  // 注:仍不含 WKWebView helper(WebContent/GPU/Networking)进程,真实物理占用会再高一些。
  const totalBytes = mem ? mem.appBytes + mem.runs.reduce((a, s) => a + s.memBytes, 0) : 0

  // +N 折叠浮层:点击切换。bar 有 overflow:hidden,故浮层用 fixed + 测量触发器位置定位,避免被裁。
  const [openPop, setOpenPop] = useState(false)
  const [popPos, setPopPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 })
  const moreRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!openPop) return
    const close = () => setOpenPop(false)
    // 捕获阶段:点任意处(含浮层外)即关
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
    }
  }, [openPop])
  const shown = running.slice(0, VISIBLE)
  const hidden = running.slice(VISIBLE)

  const togglePop = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = moreRef.current?.getBoundingClientRect()
    if (r) setPopPos({ left: r.left, bottom: window.innerHeight - r.top + 8 })
    setOpenPop((v) => !v)
  }

  return (
    <div className="runningbar">
      <span className={'pulse' + (running.length ? ' on' : '')} />
      <span className="running-label">全局</span>
      {running.length > 0 && mem && (
        <span className="running-appmem" aria-label="全局总占用:Quay 主进程 + 所有命令进程树(不含 webview helper)">
          {fmtMem(totalBytes)}
        </span>
      )}
      <NumberTicker className="running-count" value={running.length} />
      <span className="running-label">个在跑</span>
      {running.length > 0 && (
        <span className="running-list">
          {shown.map((r) => (
            <span key={r.runId} className="running-chip">
              <span className="chip-label">{r.label}</span>
              <span className="chip-mem">{memOf(r.runId)}</span>
            </span>
          ))}
          {hidden.length > 0 && (
            <button ref={moreRef} className="running-more" onClick={togglePop}>
              +{hidden.length}
            </button>
          )}
        </span>
      )}

      {openPop && (
        <div
          className="running-pop"
          style={{ left: popPos.left, bottom: popPos.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {running.map((r) => (
            <div key={r.runId} className="running-pop-row">
              <span className="chip-label">{r.label}</span>
              <span className="chip-mem">{memOf(r.runId)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
