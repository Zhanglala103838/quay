import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 只读 xterm(一期不接 stdin)。scrollback 5000 兜住前端内存。
/// 直接把 write 注册进 writers ref(ref 稳定),避免回调变化导致 term 重建丢输出。
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
    writers.current[runId] = (s: string) => term.write(s)

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
      term.dispose()
      termRef.current = null
      fitRef.current = null
      delete writers.current[runId]
    }
  }, [runId, writers])

  // display:none → block 后 xterm 不会自动重绘,直到下次写入。
  // 切回该终端(active=true)时强制 fit + refresh,立即重画已有缓冲。
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    if (!term) return
    // 等浏览器完成显示切换后再量尺寸
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* 忽略 */
      }
      term.refresh(0, term.rows - 1)
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  return <div className="term" ref={ref} />
}
