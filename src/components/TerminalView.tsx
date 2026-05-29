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
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
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
