import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

const VISIBLE = 3 // 直接铺在 bar 上的 chip 数,其余折叠进 +N

export function RunningBar() {
  // selector 必须返回稳定引用,否则 zustand v5 会判定每次都变 → 无限重渲染。
  // 取 s.runs(引用稳定),在组件体内 filter。
  const runs = useStore((s) => s.runs)
  const focusRun = useStore((s) => s.focusRun)
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
  const portsOf = (runId: string) => mem?.runs.find((s) => s.runId === runId)?.ports ?? []
  // 「全局」= Quay 主进程 + 所有在跑命令的进程树之和(故必 ≥ 任何单条命令)。
  // 注:仍不含 WKWebView helper(WebContent/GPU/Networking)进程,真实物理占用会再高一些。
  const totalBytes = mem ? mem.appBytes + mem.runs.reduce((a, s) => a + s.memBytes, 0) : 0

  // +N 折叠浮层:点击切换。bar 有 overflow:hidden,故浮层用 fixed + 测量触发器位置定位,避免被裁。
  const [openPop, setOpenPop] = useState(false)
  const [popPos, setPopPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 })
  const moreRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openPop) return
    // 捕获阶段:点浮层/触发器之外即关。必须放行浮层内的 mousedown,否则它先于行 onClick 触发、
    // 把浮层卸载掉 → 行点击(跳转终端)永远落空;放行触发器避免「关了又被 toggle 开」的抖动。
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || moreRef.current?.contains(t)) return
      setOpenPop(false)
    }
    const onResize = () => setOpenPop(false)
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', onResize)
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
            <span
              key={r.runId}
              className="running-chip clickable"
              title="跳转查看此终端"
              onClick={() => focusRun(r.runId)}
            >
              <span className="chip-label">{r.label}</span>
              {portsOf(r.runId).map((p) => (
                <span key={p} className="chip-port" title={`监听端口 ${p}`}>
                  :{p}
                </span>
              ))}
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

      {/* portal 到 body:.runningbar 有 backdrop-filter(令后代 fixed 改相对它定位)+ overflow:hidden,
          内联渲染会把浮层错位并裁掉。portal 后 fixed 回到视口坐标系,与 popPos(视口测量值)对齐。 */}
      {openPop &&
        createPortal(
          <div
            ref={popRef}
            className="running-pop"
            style={{ left: popPos.left, bottom: popPos.bottom }}
          >
            {running.map((r) => (
              <div
                key={r.runId}
                className="running-pop-row clickable"
                title="跳转查看此终端"
                onClick={() => {
                  focusRun(r.runId)
                  setOpenPop(false)
                }}
              >
                <span className="chip-label">{r.label}</span>
                {portsOf(r.runId).map((p) => (
                  <span key={p} className="chip-port" title={`监听端口 ${p}`}>
                    :{p}
                  </span>
                ))}
                <span className="chip-mem">{memOf(r.runId)}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
