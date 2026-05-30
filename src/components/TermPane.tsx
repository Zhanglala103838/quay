import { useState, type MutableRefObject } from 'react'
import { TerminalView } from './TerminalView'
import { BorderBeam } from './ui/BorderBeam'
import { readTerminalText } from '../lib/termRegistry'
import type { RunState } from '../state/store'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 工作区单格:格内顶栏(状态/标签/停止或exit/拷贝/关闭)+ 复用 TerminalView。
/// visible=是否属当前页(隐藏时 display:none 但保持挂载,不丢输出)。
export function TermPane({
  run,
  writers,
  visible,
  focused,
  onFocus,
  onStop,
  onClose,
  onRestart,
}: {
  run: RunState
  writers: Writers
  visible: boolean
  focused: boolean
  onFocus: () => void
  onStop: (runId: string, label: string) => void
  onClose: (runId: string, running: boolean) => void
  onRestart: (run: RunState) => void
}) {
  const running = run.status === 'running'
  return (
    <div
      className={'term-cell' + (focused ? ' focused' : '')}
      style={{ display: visible ? 'flex' : 'none' }}
      onMouseDown={onFocus}
    >
      {focused && visible && (
        <BorderBeam duration={running ? 5 : 7} color={running ? 'var(--green)' : undefined} />
      )}
      <div className="cell-head">
        <span className={'dot ' + run.status} />
        <span className="cell-label" title={run.command}>
          {run.label}
        </span>
        <button
          className="tab-restart"
          title="重新启动这个命令"
          onClick={(e) => {
            e.stopPropagation()
            onRestart(run)
          }}
        >
          ↻
        </button>
        {running ? (
          <button
            className="tab-stop"
            title="停止"
            onClick={(e) => {
              e.stopPropagation()
              onStop(run.runId, run.label)
            }}
          >
            ■
          </button>
        ) : (
          <span className="tab-exit">exit {run.exitCode ?? '?'}</span>
        )}
        <CopyButtons runId={run.runId} />
        <button
          className="tab-close"
          title={running ? '停止并关闭' : '关闭'}
          onClick={(e) => {
            e.stopPropagation()
            onClose(run.runId, running)
          }}
        >
          ×
        </button>
      </div>
      <div className="cell-body">
        <TerminalView
          runId={run.runId}
          writers={writers}
          active={visible}
          interactive={run.interactive}
        />
      </div>
    </div>
  )
}

/// 顶栏内拷贝按钮:最近 100 / 300 / 全部行 → 剪贴板(由 RunTabs.CopyBar 平移而来)。
function CopyButtons({ runId }: { runId: string }) {
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
  const onClick = (e: React.MouseEvent, n: number, label: string) => {
    e.stopPropagation()
    copy(n, label)
  }
  return (
    <span className="cell-copy">
      {flash ? (
        <span className="term-copied">✓ {flash}</span>
      ) : (
        <>
          <button className="term-copy-btn" onClick={(e) => onClick(e, 100, '100')}>
            100
          </button>
          <button className="term-copy-btn" onClick={(e) => onClick(e, 300, '300')}>
            300
          </button>
          <button className="term-copy-btn" onClick={(e) => onClick(e, Infinity, '全部')}>
            全部
          </button>
        </>
      )}
    </span>
  )
}
