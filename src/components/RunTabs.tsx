import { type MutableRefObject } from 'react'
import { useStore } from '../state/store'
import { TerminalView } from './TerminalView'
import { stopCommand } from '../lib/ipc'
import { BorderBeam } from './ui/BorderBeam'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

export function RunTabs({ writers }: { writers: Writers }) {
  const { runs, activeRunId, setActive, activeProjectId } = useStore()

  // 工作区跟着当前项目走:只显示当前项目(及未归属)的 run。
  const visible = runs.filter((r) => !activeProjectId || r.projectId === activeProjectId || !r.projectId)
  // 当前 tab 不在本项目可见集时,回退到本项目第一个 run。
  const effectiveActive = visible.some((r) => r.runId === activeRunId)
    ? activeRunId
    : (visible[0]?.runId ?? null)

  if (visible.length === 0) {
    return (
      <div className="runtabs empty">
        <div className="empty-main">
          <div className="empty-anchor">⚓</div>
          <div className="empty-main-text">点左侧任一命令开始运行 ▶</div>
        </div>
      </div>
    )
  }

  return (
    <div className="runtabs">
      <div className="tabbar">
        {visible.map((r) => {
          const active = r.runId === effectiveActive
          return (
            <div
              key={r.runId}
              className={'tab' + (active ? ' active' : '')}
              onClick={() => setActive(r.runId)}
              title={r.command}
            >
              {active && r.status === 'running' && <BorderBeam duration={5} color="var(--green)" />}
              {active && r.status !== 'running' && <BorderBeam duration={7} />}
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
          )
        })}
      </div>

      {/* 所有 run 的终端都保持挂载(切项目不丢输出),只显示当前激活的那个 */}
      {runs.map((r) => (
        <div
          key={r.runId}
          className="term-pane"
          style={{ display: r.runId === effectiveActive ? 'block' : 'none' }}
        >
          <TerminalView runId={r.runId} writers={writers} />
        </div>
      ))}
    </div>
  )
}
