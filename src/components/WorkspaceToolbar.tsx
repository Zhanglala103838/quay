import { useStore } from '../state/store'
import { closeCommand } from '../lib/ipc'
import { pageCount as calcPageCount, type Layout } from '../lib/paging'

const LAYOUTS: { n: Layout; label: string }[] = [
  { n: 1, label: '单格' },
  { n: 2, label: '双格' },
  { n: 4, label: '四格' },
]

/// 工作区顶部工具条:左=布局分段切换;右=翻页器。
/// 翻页器:pageCount≤8 显示可点击页点(随机跳转);>8 降级为数字 n/N 避免点墙。
export function WorkspaceToolbar() {
  const { runs, activeProjectId, layout, setLayout, currentPage, setPage, closeRun } = useStore()
  const visible = runs.filter(
    (r) => !activeProjectId || r.projectId === activeProjectId || !r.projectId,
  )
  const pages = calcPageCount(visible.length, layout)
  // 只挑「已结束」的终端(status==='exited'),进行中的绝不动。
  const exited = visible.filter((r) => r.status === 'exited')
  const closeExited = () => {
    exited.forEach((r) => {
      closeCommand(r.runId).catch(() => {}) // 释放后端 run 资源
      closeRun(r.runId) // 从工作区移除该格
    })
  }

  return (
    <div className="ws-toolbar">
      <div className="ws-toolbar-left">
        <div className="ws-layouts">
          {LAYOUTS.map((l) => (
            <button
              key={l.n}
              className={'ws-layout-btn' + (layout === l.n ? ' active' : '')}
              onClick={() => setLayout(l.n)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {exited.length > 0 && (
          <button
            className="ws-clear-exited"
            title="关闭所有已结束的终端(进行中的不动)"
            onClick={closeExited}
          >
            关闭已结束 {exited.length}
          </button>
        )}
      </div>
      {pages > 1 && (
        <div className="ws-pager">
          <button
            className="ws-page-arrow"
            disabled={currentPage <= 0}
            onClick={() => setPage(currentPage - 1)}
          >
            ‹
          </button>
          {pages <= 8 ? (
            <span className="ws-dots">
              {Array.from({ length: pages }, (_, i) => (
                <button
                  key={i}
                  className={'ws-dot' + (i === currentPage ? ' active' : '')}
                  title={'第 ' + (i + 1) + ' 页'}
                  onClick={() => setPage(i)}
                />
              ))}
            </span>
          ) : (
            <span className="ws-page-num">
              {currentPage + 1}/{pages}
            </span>
          )}
          <button
            className="ws-page-arrow"
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            ›
          </button>
        </div>
      )}
    </div>
  )
}
