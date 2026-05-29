import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { termRegistry, appendBuffer, flushBuffer } from '../lib/termRegistry'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 只读 xterm(一期不接 stdin)。scrollback 5000 兜住前端内存。
/// 直接把 write 注册进 writers ref(ref 稳定),避免回调变化导致 term 重建丢输出。
///
/// 性能:任意时刻只有 1 个终端可见,所以
///   1) 仅给激活终端挂 WebGL 渲染器(切走即 dispose,绕开浏览器 ~16 个 GL 上下文上限),
///      其余终端不渲染;WebGL 不可用时静默退回 xterm 默认 DOM 渲染器。
///   2) 非激活终端的输出囤进 termBuffers 而非实时 write,避免看不见的终端抢占主线程
///      解析;激活时一次性回灌。
export function TerminalView({
  runId,
  writers,
  active,
}: {
  runId: string
  writers: Writers
  active: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  // 给 writer 闭包读当前 active(writer 只注册一次,不能靠 prop 闭包)。
  const activeRef = useRef(active)

  useEffect(() => {
    const term = new Terminal({
      scrollback: 5000,
      fontSize: 12.5,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      letterSpacing: 0.2,
      lineHeight: 1.25,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      allowTransparency: true,
      theme: {
        background: 'rgba(0, 0, 0, 0)',
        foreground: '#cdd9e8',
        cursor: '#38e8ff',
        selectionBackground: 'rgba(56, 232, 255, 0.25)',
        black: '#0a1018',
        red: '#ff6b6b',
        green: '#34e8a4',
        yellow: '#fbbf24',
        blue: '#38e8ff',
        magenta: '#a78bfa',
        cyan: '#2dd4bf',
        white: '#cdd9e8',
        brightBlack: '#6b7d93',
        brightRed: '#ff8585',
        brightGreen: '#5ff0bb',
        brightYellow: '#fcd34d',
        brightBlue: '#7af0ff',
        brightMagenta: '#c4b5fd',
        brightCyan: '#5eead4',
        brightWhite: '#f0f6ff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    termRegistry[runId] = term
    // 激活终端实时写;非激活终端囤进缓冲(激活/拷贝前回灌),不抢主线程解析。
    writers.current[runId] = (s: string) => {
      if (activeRef.current) term.write(s)
      else appendBuffer(runId, s)
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* 容器瞬时 0 尺寸时 fit 抛错,忽略 */
      }
    })
    ro.observe(ref.current!)

    return () => {
      ro.disconnect()
      webglRef.current?.dispose()
      webglRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
      delete termRegistry[runId]
      delete writers.current[runId]
    }
  }, [runId, writers])

  // 激活/切走:
  //   激活 → 挂 WebGL(若可用)+ 回灌隐藏期缓冲 + fit + refresh,立即重画。
  //   切走 → dispose WebGL 释放 GL 上下文(隐藏终端不渲染)。
  // display:none → block 后 xterm 不会自动重绘,直到下次写入,故激活时强制 fit+refresh。
  useEffect(() => {
    activeRef.current = active
    const term = termRef.current
    if (!term) return

    if (!active) {
      webglRef.current?.dispose()
      webglRef.current = null
      return
    }

    // 仅激活终端挂 WebGL;失败(WKWebView 无 WebGL2 等)静默退回 DOM 渲染器。
    if (!webglRef.current) {
      try {
        const addon = new WebglAddon()
        addon.onContextLoss(() => {
          addon.dispose()
          webglRef.current = null
        })
        term.loadAddon(addon)
        webglRef.current = addon
      } catch {
        /* WebGL 不可用,退回默认 DOM 渲染 */
      }
    }

    let raf = 0
    let cancelled = false
    // 先回灌隐藏期缓冲并等解析完,再量尺寸 + 重画。
    flushBuffer(runId).then(() => {
      if (cancelled) return
      raf = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
        } catch {
          /* 忽略 */
        }
        term.refresh(0, term.rows - 1)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [active, runId])

  return <div className="term" ref={ref} />
}
