import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { termRegistry, appendBuffer, flushBuffer } from '../lib/termRegistry'
import { useSettings } from '../state/settings'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 只读 xterm(一期不接 stdin)。scrollback 5000 兜住前端内存。
/// 直接把 write 注册进 writers ref(ref 稳定),避免回调变化导致 term 重建丢输出。
///
/// 性能:任意时刻只有 1 个终端可见,所以
///   1) 仅给激活终端挂 WebGL 渲染器(切走即 dispose,绕开浏览器 ~16 个 GL 上下文上限),
///      其余终端不渲染;WebGL 不可用、或设置里关掉「GPU 渲染加速」时退回 xterm 默认 DOM 渲染器。
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
  // GPU 渲染加速开关(设置项)。关闭则不挂 WebGL,退回 xterm 默认 DOM 渲染器。
  const gpuAccel = useSettings((s) => s.render.gpuAcceleration)
  // 给 writer 闭包读当前 active(writer 只注册一次,不能靠 prop 闭包)。
  const activeRef = useRef(active)

  useEffect(() => {
    const term = new Terminal({
      scrollback: 5000,
      fontSize: 12.5,
      // 字体名须与 @fontsource-variable 实际注册的家族名一致(见 index.css --font-mono),
      // 否则始终回退 Menlo;且字体加载完字符宽度会变,挂载后会再补一次 fit。
      fontFamily: "'JetBrains Mono Variable', Menlo, Monaco, 'Courier New', monospace",
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
    termRef.current = term
    fitRef.current = fit
    const fitSafely = () => {
      try {
        fitRef.current?.fit()
      } catch {
        /* 容器瞬时 0 尺寸时 fit 抛错,忽略 */
      }
    }
    // 不在挂载帧同步 fit:网格里格子此刻可能还没拿到最终宽度,量错列数后——因为 fit 只改
    // xterm 内部列数、不改 .term 盒子尺寸——ResizeObserver 不会再触发,错误列数会被永久卡住。
    // 故延到下一帧(布局稳定)再 fit;webfont 加载完字符宽度会变,字体就绪后再补一次。
    requestAnimationFrame(fitSafely)
    document.fonts?.ready.then(fitSafely)
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

  // 激活/切走/切 GPU 开关:
  //   激活 + GPU 开 → 挂 WebGL(若可用)+ 回灌隐藏期缓冲 + fit + refresh,立即重画。
  //   激活 + GPU 关 → 卸掉 WebGL(若已挂),退回 DOM 渲染器并重画。
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

    if (gpuAccel) {
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
    } else {
      // GPU 关:卸掉 WebGL,xterm 自动退回 DOM 渲染器(下方 raf 里 refresh 重画)。
      webglRef.current?.dispose()
      webglRef.current = null
    }

    let raf = 0
    let cancelled = false
    // 激活时先 fit(此刻格子已 display:flex、布局就绪,量到正确宽度),再回灌隐藏期缓冲——
    // 让重放的 \r 进度类输出按正确列数渲染,避免按旧窄列数回放后再 reflow 造成错位;最后重画。
    raf = requestAnimationFrame(() => {
      if (cancelled) return
      try {
        fitRef.current?.fit()
      } catch {
        /* 忽略 */
      }
      flushBuffer(runId).then(() => {
        if (cancelled) return
        term.refresh(0, term.rows - 1)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [active, runId, gpuAccel])

  return <div className="term" ref={ref} />
}
