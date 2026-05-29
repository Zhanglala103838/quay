import { type MutableRefObject } from 'react'
import { useStore } from '../state/store'
import { TerminalView } from './TerminalView'
import { stopCommand } from '../lib/ipc'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

export function RunTabs({ writers }: { writers: Writers }) {
  const { runs, activeRunId, setActive } = useStore()

  if (runs.length === 0) {
    return (
      <div className="runtabs empty">
        <div className="empty-main">点左侧任一命令开始运行 ▶</div>
      </div>
    )
  }

  return (
    <div className="runtabs">
      <div className="tabbar">
        {runs.map((r) => (
          <div
            key={r.runId}
            className={'tab' + (r.runId === activeRunId ? ' active' : '')}
            onClick={() => setActive(r.runId)}
            title={r.command}
          >
            <span className={'dot ' + r.status} />
            <span className="tab-label">{r.label}</span>
            {r.status === 'running' ? (
              <button
                className="tab-stop"
                title="停止"
                onClick={(e) => {
                  e.stopPropagation()
                  stopCommand(r.runId)
                }}
              >
                ■
              </button>
            ) : (
              <span className="tab-exit">exit {r.exitCode ?? '?'}</span>
            )}
          </div>
        ))}
      </div>

      {runs.map((r) => (
        <div
          key={r.runId}
          className="term-pane"
          style={{ display: r.runId === activeRunId ? 'block' : 'none' }}
        >
          <TerminalView runId={r.runId} writers={writers} />
        </div>
      ))}
    </div>
  )
}
