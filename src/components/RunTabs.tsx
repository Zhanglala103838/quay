import { type MutableRefObject, useState } from 'react'
import { useStore } from '../state/store'
import { TerminalView } from './TerminalView'
import { stopCommand, closeCommand } from '../lib/ipc'
import { askConfirm } from '../state/confirm'
import { readTerminalText } from '../lib/termRegistry'
import { BorderBeam } from './ui/BorderBeam'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

export function RunTabs({ writers }: { writers: Writers }) {
  const { runs, activeRunId, setActive, activeProjectId, closeRun } = useStore()

  const doClose = (runId: string, running: boolean) => {
    if (running) stopCommand(runId)
    closeCommand(runId).catch(() => {})
    closeRun(runId)
  }

  // 关闭 tab:运行中要确认(会终止进程);已结束/终止的终端直接关,无需确认。
  const close = (e: React.MouseEvent, runId: string, running: boolean) => {
    e.stopPropagation()
    if (running) {
      askConfirm({
        title: '停止并关闭运行中的终端?',
        message: '会终止该进程。',
        confirmText: '停止并关闭',
        onConfirm: () => doClose(runId, true),
      })
    } else {
      doClose(runId, false)
    }
  }

  // 停止运行中的命令(终止进程)→ 确认
  const stop = (e: React.MouseEvent, runId: string, label: string) => {
    e.stopPropagation()
    askConfirm({
      title: '停止运行中的命令?',
      message: label,
      confirmText: '停止',
      onConfirm: () => stopCommand(runId),
    })
  }

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
                <button className="tab-stop" title="停止" onClick={(e) => stop(e, r.runId, r.label)}>
                  ■
                </button>
              ) : (
                <span className="tab-exit">exit {r.exitCode ?? '?'}</span>
              )}
              <button
                className="tab-close"
                title={r.status === 'running' ? '停止并关闭' : '关闭'}
                onClick={(e) => close(e, r.runId, r.status === 'running')}
              >
                ×
              </button>
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
          <CopyBar runId={r.runId} />
          <TerminalView runId={r.runId} writers={writers} active={r.runId === effectiveActive} />
        </div>
      ))}
    </div>
  )
}

/// 终端右上角拷贝工具条:最近 100 / 300 / 全部行 → 剪贴板。
function CopyBar({ runId }: { runId: string }) {
  const [flash, setFlash] = useState('')
  const copy = (n: number, label: string) => {
    const text = readTerminalText(runId, n)
    if (!text) return
    navigator.clipboard.writeText(text).then(
      () => {
        setFlash(label)
        setTimeout(() => setFlash(''), 1300)
      },
      () => {},
    )
  }
  return (
    <div className="term-toolbar">
      {flash ? (
        <span className="term-copied">✓ 已拷贝 · {flash}</span>
      ) : (
        <>
          <span className="term-toolbar-label">拷贝日志</span>
          <button className="term-copy-btn" onClick={() => copy(100, '最近 100 行')}>
            100
          </button>
          <button className="term-copy-btn" onClick={() => copy(300, '最近 300 行')}>
            300
          </button>
          <button className="term-copy-btn" onClick={() => copy(Infinity, '全部')}>
            全部
          </button>
        </>
      )}
    </div>
  )
}
