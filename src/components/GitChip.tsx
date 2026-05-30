import { useEffect, useState } from 'react'
import { gitBrief } from '../lib/ipc'
import type { GitBrief } from '../lib/types'
import { useStore } from '../state/store'

/// 侧边栏分支 chip：一眼扫分支 + 脏/净 + ahead/behind。点击在主区打开 git 面板。
/// useEffect 依赖 gitRefreshTick —— 窗口重获焦点(§5)时统一重拉，避免 commit 完 chip 仍旧脏数。
export function GitChip({ path }: { path: string }) {
  const [brief, setBrief] = useState<GitBrief | null>(null)
  const openGit = useStore((s) => s.openGit)
  const tick = useStore((s) => s.gitRefreshTick)

  useEffect(() => {
    let cancelled = false
    gitBrief(path)
      .then((b) => !cancelled && setBrief(b))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [path, tick])

  // 非 git 仓库 / 还没拿到 → 不渲染
  if (!brief || !brief.isRepo) return null

  const label = brief.detached ? `游离 @ ${brief.headShort}` : brief.branch
  const sync =
    brief.hasUpstream && (brief.ahead > 0 || brief.behind > 0)
      ? `${brief.ahead > 0 ? `↑${brief.ahead}` : ''}${brief.behind > 0 ? `↓${brief.behind}` : ''}`
      : ''

  return (
    <div className="git-chip-line">
      <span
        className="git-chip"
        title="查看 git 状态"
        onClick={(e) => {
          e.stopPropagation()
          openGit(path)
        }}
      >
        <span className="git-chip-branch">⎇ {label}</span>
        {brief.dirty > 0 ? (
          <span className="git-chip-dirty">●{brief.dirty}</span>
        ) : (
          <span className="git-chip-clean">✓</span>
        )}
        {sync && <span className="git-chip-sync">{sync}</span>}
      </span>
    </div>
  )
}
