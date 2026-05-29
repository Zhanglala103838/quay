import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { askConfirm } from '../state/confirm'
import { scanDir } from '../lib/ipc'
import type { Script } from '../lib/types'
import { categorize, type Category, type CmdLeaf, type PrefixGroup } from '../lib/grouping'
import { useSettings } from '../state/settings'
import { smartGroup, explainCommand } from '../lib/deepseek'
import { InputModal } from './InputModal'
import { ShimmerButton } from './ui/ShimmerButton'
import { BlurFade } from './ui/BlurFade'
import { DeleteButton } from './ui/DeleteButton'

interface RunFn {
  (label: string, cwd: string, command: string): void
}

type Pending =
  | { kind: 'project' }
  | { kind: 'dir'; projectId: string }
  | { kind: 'manual'; projectId: string }
  | null

export function Sidebar({ onRun }: { onRun: RunFn }) {
  const {
    config,
    addProject,
    addDirectory,
    removeDirectory,
    addManualCommand,
    removeManualCommand,
    removeProject,
    setActiveProject,
  } = useStore()
  // runs 引用稳定，组件体内派生 running label 集合（zustand v5）
  const runs = useStore((s) => s.runs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const runningLabels = new Set(runs.filter((r) => r.status === 'running').map((r) => r.label))
  // 每个项目当前在跑数(按 projectId 归属)
  const runningByProject = (pid: string) =>
    runs.filter((r) => r.projectId === pid && r.status === 'running').length
  const [pending, setPending] = useState<Pending>(null)

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">项目</span>
        <ShimmerButton onClick={() => setPending({ kind: 'project' })}>+ 项目</ShimmerButton>
      </div>

      {config.projects.length === 0 && (
        <BlurFade delay={0.1}>
          <div className="empty-hint">
            还没有项目。点「+ 项目」开始,再给项目绑定目录或手动命令。
          </div>
        </BlurFade>
      )}

      {config.projects.map((p, i) => (
        <BlurFade key={p.id} delay={0.05 * i}>
          <div className={'project' + (p.id === activeProjectId ? ' active' : '')}>
            <div
              className="project-head"
              onClick={() => setActiveProject(p.id)}
              aria-label="设为当前项目"
              style={{ cursor: 'pointer' }}
            >
              <span className="project-name">
                {p.name}
                {runningByProject(p.id) > 0 && (
                  <span className="project-running">
                    {runningByProject(p.id)}
                  </span>
                )}
              </span>
              <span className="project-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="pill-btn"
                  aria-label="绑定含 package.json 的目录"
                  onClick={() => setPending({ kind: 'dir', projectId: p.id })}
                >
                  +目录
                </button>
                <button
                  className="pill-btn"
                  aria-label="新增手动命令"
                  onClick={() => setPending({ kind: 'manual', projectId: p.id })}
                >
                  +命令
                </button>
                <DeleteButton
                  title="移除项目"
                  onClick={() =>
                    askConfirm({
                      title: `删除项目「${p.name}」?`,
                      message: '将移除该项目及其目录/命令配置(不影响磁盘上的文件)。',
                      confirmText: '删除',
                      onConfirm: () => removeProject(p.id),
                    })
                  }
                />
              </span>
            </div>

            {p.directories.map((d) => (
              <DirNode
                key={d.id}
                path={d.path}
                onRun={onRun}
                runningLabels={runningLabels}
                onRemove={() =>
                  askConfirm({
                    title: `删除目录绑定「${d.path.split('/').filter(Boolean).pop()}」?`,
                    message: '仅从该项目移除此目录绑定(不删磁盘上的文件)。',
                    confirmText: '删除',
                    onConfirm: () => removeDirectory(p.id, d.id),
                  })
                }
              />
            ))}

            {p.manualCommands.length > 0 && (
              <div className="cat">
                <div className="cat-label">手动</div>
                {p.manualCommands.map((m) => (
                  <CmdRow
                    key={m.id}
                    display={m.label}
                    command={`${m.command} · ${m.cwd}`}
                    running={runningLabels.has(m.label)}
                    onRun={() => onRun(m.label, m.cwd, m.command)}
                    onRemove={() =>
                      askConfirm({
                        title: `删除手动命令「${m.label}」?`,
                        confirmText: '删除',
                        onConfirm: () => removeManualCommand(p.id, m.id),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </BlurFade>
      ))}

      {pending?.kind === 'project' && (
        <InputModal
          title="新增项目"
          fields={[{ key: 'name', label: '项目名(最多 6 字)', placeholder: '如 我的项目', maxLength: 6 }]}
          onSubmit={(v) => {
            addProject(v.name.trim())
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'dir' && (
        <InputModal
          title="绑定目录"
          fields={[
            {
              key: 'path',
              label: '目录绝对路径(含 package.json)',
              placeholder: '/Users/you/code/your-project',
            },
          ]}
          onSubmit={(v) => {
            addDirectory(pending.projectId, v.path.trim())
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'manual' && (
        <InputModal
          title="新增手动命令"
          fields={[
            { key: 'command', label: '命令', placeholder: '如 php think run' },
            {
              key: 'cwd',
              label: '工作目录 cwd(可选已绑目录或自定义)',
              placeholder: '/Users/you/code/api',
              // 快速选择:该项目已绑定的目录;也可手动输入任意路径
              options: config.projects
                .find((p) => p.id === pending.projectId)
                ?.directories.map((d) => d.path),
            },
            // 标签默认跟随命令自动填充(可改),让用户一眼知道这条是什么
            { key: 'label', label: '标签', placeholder: '默认跟随命令', mirrorOf: 'command' },
          ]}
          onSubmit={(v) => {
            const cmd = v.command.trim()
            const cwd = v.cwd.trim()
            if (!cmd || !cwd) return
            addManualCommand(pending.projectId, v.label.trim() || cmd, cwd, cmd)
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}

/// 单条命令行。running → 高亮 + 脉冲圆点。配置 DeepSeek 后可点 ? 让 AI 解释用途。
function CmdRow({
  display,
  command,
  running,
  onRun,
  onRemove,
}: {
  display: string
  command: string
  running: boolean
  onRun: () => void
  onRemove?: () => void
}) {
  const configured = useSettings((s) => s.configured)
  const [explain, setExplain] = useState<{ loading: boolean; text: string; err: boolean } | null>(
    null,
  )

  const toggleExplain = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (explain) {
      setExplain(null)
      return
    }
    setExplain({ loading: true, text: '', err: false })
    explainCommand(display, command)
      .then((text) => setExplain({ loading: false, text, err: false }))
      .catch((err) =>
        setExplain({ loading: false, text: err instanceof Error ? err.message : String(err), err: true }),
      )
  }

  return (
    <>
      {/* 原生 title 代替 HeroUI Tooltip —— 避免 overlay 拦截滚动/点击 */}
      <div className={'cmd' + (running ? ' running' : '')} onClick={onRun}>
        <span className={'run-icon' + (running ? ' on' : '')}>{running ? '●' : '▶'}</span>
        <span className="cmd-name">{display}</span>
        {running && <span className="cmd-running-tag">运行中</span>}
        {configured && (
          <button className="explain-btn" aria-label="AI 解释这条命令" onClick={toggleExplain}>
            {explain ? '×' : '?'}
          </button>
        )}
        {onRemove && <DeleteButton title="删除此命令" floatRight onClick={onRemove} />}
      </div>
      {explain && (
        <div className={'cmd-explain' + (explain.err ? ' err' : '')}>
          {explain.loading ? (
            <>
              <span className="ai-spinner" /> AI 解释中…
            </>
          ) : (
            explain.text
          )}
        </div>
      )}
    </>
  )
}

/// 前缀子分组（如 deploy:* / db:*）：可折叠，默认收起，标头带计数 + 活动指示。
function PrefixGroupNode({
  group,
  dirName,
  path,
  onRun,
  runningLabels,
}: {
  group: PrefixGroup
  dirName: string
  path: string
  onRun: RunFn
  runningLabels: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const runningCount = group.items.filter((it) =>
    runningLabels.has(`${dirName}:${it.name}`),
  ).length

  return (
    <div className="pgroup">
      <div className="pgroup-head" onClick={() => setOpen((o) => !o)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="pgroup-name">{group.prefix}</span>
        <span className="pgroup-count">{group.items.length}</span>
        {runningCount > 0 && <span className="activity-dot" />}
      </div>
      {open && (
        <div className="pgroup-body">
          {group.items.map((it) => (
            <CmdRow
              key={it.name}
              display={it.name === group.prefix ? it.name : it.name.slice(group.prefix.length + 1)}
              command={it.command}
              running={runningLabels.has(`${dirName}:${it.name}`)}
              onRun={() => onRun(`${dirName}:${it.name}`, path, `npm run ${it.name}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DirNode({
  path,
  onRun,
  runningLabels,
  onRemove,
}: {
  path: string
  onRun: RunFn
  runningLabels: Set<string>
  onRemove?: () => void
}) {
  const [scripts, setScripts] = useState<Script[]>([])
  const [warn, setWarn] = useState('')
  const [open, setOpen] = useState(false) // 目录默认收起
  const configured = useSettings((s) => s.configured)
  // AI 分组开关按目录持久化(重启不丢);分组结果本身已由 smartGroup 缓存在 localStorage。
  const aiModeKey = `quay.aimode.${path}`
  const [aiMode, setAiMode] = useState(() => localStorage.getItem(aiModeKey) === '1')
  const [aiCats, setAiCats] = useState<Category[] | null>(null)
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'error'>('idle')

  const toggleAi = () =>
    setAiMode((m) => {
      const next = !m
      localStorage.setItem(aiModeKey, next ? '1' : '0')
      return next
    })

  useEffect(() => {
    let cancelled = false
    scanDir(path).then((r) => {
      if (cancelled) return
      setScripts(r.scripts)
      if (!r.dirExists) {
        setWarn('目录不存在或无访问权限(检查 macOS 系统设置 → 隐私与安全性 → 文件和文件夹 / 完整磁盘访问)')
      } else if (!r.hasPackageJson) {
        setWarn('此目录无 package.json')
      } else if (r.scripts.length === 0) {
        setWarn('package.json 无 scripts')
      } else {
        setWarn('')
      }
    })
    return () => {
      cancelled = true
    }
  }, [path])

  // AI 智能分组：开启后拉取并缓存；失败回退启发式
  useEffect(() => {
    if (!aiMode || scripts.length === 0) return
    let cancelled = false
    setAiState('loading')
    smartGroup(scripts)
      .then((cats) => {
        if (cancelled) return
        setAiCats(cats)
        setAiState('idle')
      })
      .catch(() => {
        if (cancelled) return
        setAiState('error')
        setAiMode(false) // 失败回退启发式
      })
    return () => {
      cancelled = true
    }
  }, [aiMode, scripts])

  const dirName = path.split('/').filter(Boolean).pop() || path
  const categories = aiMode && aiCats ? aiCats : categorize(scripts)
  const dirRunning = scripts.filter((s) => runningLabels.has(`${dirName}:${s.name}`)).length

  return (
    <div className="dir">
      {/* 用原生 title,不用 HeroUI Tooltip —— 后者的 overlay 会拦截列表区的点击和滚动 */}
      <div className="dir-path" onClick={() => setOpen((o) => !o)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="dir-icon">📁</span>
        <span className="dir-name">{dirName}</span>
        {scripts.length > 0 && <span className="dir-count">{scripts.length}</span>}
        {dirRunning > 0 && <span className="activity-dot" />}
        {onRemove && <DeleteButton title="删除此目录绑定" floatRight onClick={onRemove} />}
      </div>

      {open && (
        <div className="dir-body">
          {configured && scripts.length > 0 && (
            <div className="dir-toolbar">
              <button
                className={'ai-btn' + (aiMode ? ' active' : '')}
                disabled={aiState === 'loading'}
                onClick={toggleAi}
                aria-label="用 DeepSeek 智能重新分组命令"
              >
                {aiState === 'loading' ? (
                  <>
                    <span className="ai-spinner" /> 分组中…
                  </>
                ) : aiMode ? (
                  '✨ AI 分组 · 开'
                ) : (
                  '✨ AI 智能分组'
                )}
              </button>
            </div>
          )}
          {warn && <div className="warn">{warn}</div>}
          {categories.map((cat) => (
            <div className="cat" key={cat.key}>
              <div className="cat-label">{cat.label}</div>
              {cat.groups.map((g) => (
                <PrefixGroupNode
                  key={g.prefix}
                  group={g}
                  dirName={dirName}
                  path={path}
                  onRun={onRun}
                  runningLabels={runningLabels}
                />
              ))}
              {cat.loose.map((it: CmdLeaf) => (
                <CmdRow
                  key={it.name}
                  display={it.name}
                  command={it.command}
                  running={runningLabels.has(`${dirName}:${it.name}`)}
                  onRun={() => onRun(`${dirName}:${it.name}`, path, `npm run ${it.name}`)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
