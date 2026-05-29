import { useEffect, useRef, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 只读 xterm(一期不接 stdin)。scrollback 5000 兜住前端内存。
/// 直接把 write 注册进 writers ref(ref 稳定),避免回调变化导致 term 重建丢输出。
export function TerminalView({ runId, writers }: { runId: string; writers: Writers }) {
  const ref = useRef<HTMLDivElement>(null)

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
      delete writers.current[runId]
    }
  }, [runId, writers])

  return <div className="term" ref={ref} />
}
