import { useEffect, useState } from 'react'
import { gitDetail } from '../lib/ipc'
import type { GitDetail, GitFile } from '../lib/types'
import { useStore } from '../state/store'
import { BlurFade } from './ui/BlurFade'

/// 行数 sentinel → 显示文本。-2 未跟踪 / -1 二进制 / 其余实际 +/-。
function lineStat(f: GitFile) {
  if (f.status === '??' || f.added === -2) return <span className="git-stat-new">新文件</span>
  if (f.added === -1) return <span className="git-stat-bin">bin</span>
  return (
    <span className="git-stat">
      {f.added > 0 && <span className="git-add">+{f.added}</span>}
      {f.deleted > 0 && <span className="git-del">-{f.deleted}</span>}
    </span>
  )
}

/// 状态码 → 颜色 class（M 琥珀 / A 绿 / D 红 / ?? 灰 / 其余默认）。
function statusClass(st: string) {
  if (st === '??') return 'st-untracked'
  if (st.includes('D')) return 'st-del'
  if (st.includes('A')) return 'st-add'
  if (st.includes('M') || st.includes('R')) return 'st-mod'
  return 'st-other'
}

/// 主区 git 面板：分支头 + 改动列表 + 提交历史。读 activeGitPath，
/// useEffect 依赖 [path, tick, spin] → 开 + 聚焦 + 手动刷新都重拉。
export function GitPanel() {
  const path = useStore((s) => s.activeGitPath)
  const tick = useStore((s) => s.gitRefreshTick)
  const closeGit = useStore((s) => s.closeGit)
  const [detail, setDetail] = useState<GitDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [spin, setSpin] = useState(0) // 手动刷新触发器

  useEffect(() => {
    if (!path) return
    let cancelled = false
    // 包进 async 函数:setState 不在 effect 体内同步调用(规避 set-state-in-effect)。
    const fetchDetail = async () => {
      setLoading(true)
      try {
        const d = await gitDetail(path)
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) setDetail(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void fetchDetail()
    return () => {
      cancelled = true
    }
  }, [path, tick, spin])

  if (!path) return null

  const dirName = path.split('/').filter(Boolean).pop() || path
  const branchLabel = detail
    ? detail.detached
      ? `游离 @ ${detail.headShort}`
      : detail.branch
    : ''

  return (
    <div className="git-panel">
      <div className="git-panel-head">
        <div className="git-panel-title">
          <span className="git-panel-repo">{dirName}</span>
          {detail?.isRepo && <span className="git-panel-branch">⎇ {branchLabel}</span>}
          {detail?.hasUpstream && (detail.ahead > 0 || detail.behind > 0) && (
            <span className="git-panel-sync">
              {detail.ahead > 0 && `↑${detail.ahead}`}
              {detail.behind > 0 && ` ↓${detail.behind}`}
            </span>
          )}
        </div>
        <div className="git-panel-actions">
          <button
            className={'git-refresh-btn' + (loading ? ' spinning' : '')}
            title="刷新"
            onClick={() => setSpin((s) => s + 1)}
            disabled={loading}
          >
            ⟳
          </button>
          <button className="git-close-btn" title="返回终端" onClick={() => closeGit()}>
            ×
          </button>
        </div>
      </div>

      {detail && !detail.isRepo && <div className="git-panel-empty">此目录不是 git 仓库</div>}

      {detail?.isRepo && (
        <div className="git-panel-body">
          <section className="git-section">
            <div className="git-section-label">
              改动 {detail.files.length > 0 && `(${detail.files.length})`}
            </div>
            {detail.files.length === 0 ? (
              <div className="git-clean-hint">工作区干净 ✓</div>
            ) : (
              detail.files.map((f, i) => (
                <BlurFade key={f.path} delay={Math.min(0.02 * i, 0.2)}>
                  <div className="git-file-row">
                    <span className={'git-file-status ' + statusClass(f.status)}>
                      {f.status || '·'}
                    </span>
                    <span className="git-file-path">{f.path}</span>
                    {lineStat(f)}
                  </div>
                </BlurFade>
              ))
            )}
          </section>

          <section className="git-section">
            <div className="git-section-label">提交历史</div>
            {detail.commits.length === 0 ? (
              <div className="git-clean-hint">还没有提交</div>
            ) : (
              detail.commits.map((c) => (
                <div className="git-commit-row" key={c.hash}>
                  <span className="git-commit-hash">{c.hash}</span>
                  <span className="git-commit-subject">{c.subject}</span>
                  <span className="git-commit-time">{c.relTime}</span>
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </div>
  )
}
