import { useEffect, useState } from 'react'
import { gitDetail } from '../lib/ipc'
import type { GitDetail, GitFile } from '../lib/types'
import { useStore } from '../state/store'
import { BlurFade } from './ui/BlurFade'
import { GitGraph } from './GitGraph'

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

/// 主区 git 面板:分支头(下拉切换) + 改动列表 + 拓扑提交树。
/// useEffect 依赖 [path, tick, spin, rev] → 开 + 聚焦 + 手动刷新 + 切分支 都重拉。
export function GitPanel() {
  const path = useStore((s) => s.activeGitPath)
  const tick = useStore((s) => s.gitRefreshTick)
  const closeGit = useStore((s) => s.closeGit)
  const [detail, setDetail] = useState<GitDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [spin, setSpin] = useState(0) // 手动刷新触发器
  const [rev, setRev] = useState('') // 查看哪个分支('' = 当前 HEAD)
  const [menuOpen, setMenuOpen] = useState(false)
  // 注:切目录时由 Workspace 的 key={activeGitPath} 整组件重挂复位 rev/menuOpen,无需 effect。

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const fetchDetail = async () => {
      setLoading(true)
      try {
        const d = await gitDetail(path, rev)
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
  }, [path, tick, spin, rev])

  if (!path) return null

  const dirName = path.split('/').filter(Boolean).pop() || path
  const viewing = detail?.viewing || (detail?.detached ? `游离 @ ${detail.headShort}` : detail?.branch) || ''

  return (
    <div className="git-panel">
      <div className="git-panel-head">
        <div className="git-panel-title">
          <span className="git-panel-repo">{dirName}</span>
          {detail?.isRepo && (
            <div className="git-branch-picker">
              <button
                className={'git-branch-btn' + (menuOpen ? ' open' : '')}
                onClick={() => setMenuOpen((o) => !o)}
                disabled={detail.branches.length === 0}
                title="切换查看的分支(只读,不动工作区)"
              >
                <span className="gb-icon">⎇</span>
                <span className="gb-name">{viewing}</span>
                {detail.branches.length > 0 && <span className="gb-caret">▾</span>}
              </button>
              {menuOpen && (
                <>
                  <div className="git-branch-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="git-branch-menu">
                    {detail.branches.map((b) => (
                      <button
                        key={b.name}
                        className={'git-branch-item' + (b.name === viewing ? ' active' : '')}
                        onClick={() => {
                          setRev(b.current ? '' : b.name)
                          setMenuOpen(false)
                        }}
                      >
                        <span className="gbi-name">{b.name}</span>
                        {b.current && <span className="gbi-cur">当前</span>}
                        {!b.upstream && <span className="gbi-noup">未跟踪</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
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
              <div className="git-files-scroll">
                {detail.files.map((f, i) => (
                  <BlurFade key={f.path} delay={Math.min(0.02 * i, 0.2)}>
                    <div className="git-file-row">
                      <span className={'git-file-status ' + statusClass(f.status)}>
                        {f.status || '·'}
                      </span>
                      <span className="git-file-path">{f.path}</span>
                      {lineStat(f)}
                    </div>
                  </BlurFade>
                ))}
              </div>
            )}
          </section>

          <section className="git-section">
            <div className="git-section-label">提交树</div>
            <GitGraph commits={detail.commits} />
          </section>
        </div>
      )}
    </div>
  )
}
