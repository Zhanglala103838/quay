import { type MutableRefObject } from 'react'
import { useStore } from '../state/store'
import { TermPane } from './TermPane'
import { WorkspaceToolbar } from './WorkspaceToolbar'
import { GitPanel } from './GitPanel'
import { stopCommand, closeCommand } from '../lib/ipc'
import { askConfirm } from '../state/confirm'
import quayLogo from '../assets/quay-logo.png'

type Writers = MutableRefObject<Record<string, (s: string) => void>>

/// 右侧工作区:工具条 + CSS Grid 网格。所有 run 始终挂载,只显示当前页的格(切页/切项目不丢输出)。
export function Workspace({ writers }: { writers: Writers }) {
  const { runs, activeRunId, setActive, activeProjectId, closeRun, layout, currentPage, activeGitPath } =
    useStore()

  const doClose = (runId: string, running: boolean) => {
    if (running) stopCommand(runId)
    closeCommand(runId).catch(() => {})
    closeRun(runId)
  }
  // 关闭:运行中要确认(终止进程);已结束直接关。
  const onClose = (runId: string, running: boolean) => {
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
  const onStop = (runId: string, label: string) => {
    askConfirm({
      title: '停止运行中的命令?',
      message: label,
      confirmText: '停止',
      onConfirm: () => stopCommand(runId),
    })
  }

  // 工作区只看当前项目(及未归属)的 run。
  const visible = runs.filter(
    (r) => !activeProjectId || r.projectId === activeProjectId || !r.projectId,
  )

  const hasVisible = visible.length > 0
  // 当前页该显示哪些 run:按 visible 顺序切片(自动流式)。无可见 run 时为空集。
  const start = currentPage * layout
  const pageIds = new Set(
    hasVisible ? visible.slice(start, start + layout).map((r) => r.runId) : [],
  )

  return (
    <div className="runtabs">
      {/* 三态(spec §4.5):git 面板打开 → 只渲染 GitPanel；否则按 hasVisible 显工具条/空态。 */}
      {activeGitPath != null ? (
        <GitPanel key={activeGitPath} />
      ) : hasVisible ? (
        <WorkspaceToolbar />
      ) : (
        <div className="empty-main">
          <img src={quayLogo} className="empty-mark" alt="" draggable={false} />
          <div className="empty-main-text">点左侧任一命令开始运行 ▶</div>
        </div>
      )}
      {/* 网格始终渲染:所有终端常驻挂载。切到「无运行终端」的项目或打开 git 面板时也不能卸载网格,
          否则 xterm 实例被销毁 → scrollback 历史全丢,切回来变空白。git 面板打开 / 无可见 run 时整网格
          display:none(只显示上面的层),终端仍挂在 DOM 里、内容保留。 */}
      <div
        className={'term-grid layout-' + layout}
        style={activeGitPath != null || !hasVisible ? { display: 'none' } : undefined}
      >
        {runs.map((r) => (
          <TermPane
            key={r.runId}
            run={r}
            writers={writers}
            visible={pageIds.has(r.runId)}
            focused={r.runId === activeRunId}
            onFocus={() => setActive(r.runId)}
            onStop={onStop}
            onClose={onClose}
          />
        ))}
      </div>
    </div>
  )
}
