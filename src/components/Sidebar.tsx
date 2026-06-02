import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { askConfirm } from '../state/confirm'
import { scanDir, watchDir, unwatchDir, collectContext } from '../lib/ipc'
import { listen } from '@tauri-apps/api/event'
import type { Command, ScanResult, CommandEntry, Proposal, ProjectContext } from '../lib/types'
import { categorize, type Category, type CmdLeaf, type PrefixGroup } from '../lib/grouping'
import { useSettings } from '../state/settings'
import { smartGroup, explainCommand, proposeCommands } from '../lib/deepseek'
import { AiProposeModal } from './AiProposeModal'
import { AiContextModal } from './AiContextModal'
import { InputModal } from './InputModal'
import { ShimmerButton } from './ui/ShimmerButton'
import { BlurFade } from './ui/BlurFade'
import { DeleteButton } from './ui/DeleteButton'
import { GitChip } from './GitChip'

interface RunFn {
  (label: string, cwd: string, command: string): void
}

type Pending =
  | { kind: 'project' }
  | { kind: 'dir'; projectId: string }
  | { kind: 'manual'; projectId: string }
  | { kind: 'manual-edit'; projectId: string; cmd: CommandEntry }
  | null

export function Sidebar({
  onRun,
  onOpenTerminal,
  onOpenVscode,
}: {
  onRun: RunFn
  onOpenTerminal: (cwd: string) => void
  onOpenVscode: (path: string) => void
}) {
  const {
    config,
    addProject,
    addDirectory,
    removeDirectory,
    addManualCommand,
    updateManualCommand,
    removeManualCommand,
    removeProject,
    setActiveProject,
    focusRun,
  } = useStore()
  // runs 引用稳定，组件体内派生 running label 集合（zustand v5）
  const runs = useStore((s) => s.runs)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const runningLabels = new Set(runs.filter((r) => r.status === 'running').map((r) => r.label))
  // 查看某运行中命令:按 label 找到 running run → 聚焦它的终端(不再跑一个)。
  const viewRun = (label: string) => {
    const r = runs.find((x) => x.label === label && x.status === 'running')
    if (r) focusRun(r.runId)
  }
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

      {config.projects.map((p, i) => {
        // 把手动/AI 命令按 cwd 归到所属绑定目录(最长前缀优先);无匹配的留作项目级 orphan。
        const norm = (s: string) => s.replace(/\/+$/, '')
        const dirIdOfCwd = (cwd: string): string | null => {
          let best: { id: string; len: number } | null = null
          for (const d of p.directories) {
            const dp = norm(d.path)
            if (norm(cwd) === dp || norm(cwd).startsWith(dp + '/')) {
              if (!best || dp.length > best.len) best = { id: d.id, len: dp.length }
            }
          }
          return best?.id ?? null
        }
        const manualByDir = new Map<string, CommandEntry[]>()
        const orphanManual: CommandEntry[] = []
        for (const m of p.manualCommands) {
          const did = dirIdOfCwd(m.cwd)
          if (did) {
            const arr = manualByDir.get(did) ?? []
            arr.push(m)
            manualByDir.set(did, arr)
          } else {
            orphanManual.push(m)
          }
        }
        return (
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
                projectId={p.id}
                path={d.path}
                manualCommands={manualByDir.get(d.id) ?? []}
                onRun={onRun}
                onView={viewRun}
                onOpenTerminal={onOpenTerminal}
                onOpenVscode={onOpenVscode}
                runningLabels={runningLabels}
                onEditManual={(cmd) => setPending({ kind: 'manual-edit', projectId: p.id, cmd })}
                onRemoveManual={(cmd) =>
                  askConfirm({
                    title: `删除命令「${cmd.label}」?`,
                    confirmText: '删除',
                    onConfirm: () => removeManualCommand(p.id, cmd.id),
                  })
                }
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

            {orphanManual.length > 0 && (
              <div className="cat manual-cat">
                <div className="cat-label">手动</div>
                {orphanManual.map((m) => (
                  <CmdRow
                    key={m.id}
                    display={m.label}
                    command={`${m.command} · ${m.cwd}`}
                    origin={m.origin}
                    running={runningLabels.has(m.label)}
                    onRun={() => onRun(m.label, m.cwd, m.command)}
                    onView={() => viewRun(m.label)}
                    onEdit={() => setPending({ kind: 'manual-edit', projectId: p.id, cmd: m })}
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
        )
      })}

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
              pickDir: true,
            },
          ]}
          onSubmit={(v) => {
            addDirectory(pending.projectId, v.path.trim())
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {(pending?.kind === 'manual' || pending?.kind === 'manual-edit') && (
        <InputModal
          title={pending.kind === 'manual-edit' ? '编辑手动命令' : '新增手动命令'}
          fields={[
            {
              key: 'command',
              label: '命令',
              placeholder: '如 php think run',
              initial: pending.kind === 'manual-edit' ? pending.cmd.command : undefined,
            },
            {
              key: 'cwd',
              label: '工作目录 cwd(可选已绑目录或自定义)',
              placeholder: '/Users/you/code/api',
              // 快速选择:该项目已绑定的目录;也可手动输入任意路径
              options: config.projects
                .find((p) => p.id === pending.projectId)
                ?.directories.map((d) => d.path),
              initial: pending.kind === 'manual-edit' ? pending.cmd.cwd : undefined,
            },
            // 标签默认跟随命令自动填充(可改),让用户一眼知道这条是什么
            {
              key: 'label',
              label: '标签',
              placeholder: '默认跟随命令',
              mirrorOf: 'command',
              initial: pending.kind === 'manual-edit' ? pending.cmd.label : undefined,
            },
          ]}
          onSubmit={(v) => {
            const cmd = v.command.trim()
            const cwd = v.cwd.trim()
            if (!cmd || !cwd) return
            if (pending.kind === 'manual-edit') {
              updateManualCommand(pending.projectId, pending.cmd.id, v.label.trim() || cmd, cwd, cmd)
            } else {
              addManualCommand(pending.projectId, v.label.trim() || cmd, cwd, cmd)
            }
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
  source,
  origin,
  running,
  onRun,
  onView,
  onEdit,
  onRemove,
}: {
  display: string
  command: string
  source?: string
  origin?: 'ai'
  running: boolean
  onRun: () => void
  onView?: () => void
  onEdit?: () => void
  onRemove?: () => void
}) {
  const configured = useSettings((s) => s.configured)
  const [explain, setExplain] = useState<{ loading: boolean; text: string; err: boolean } | null>(
    null,
  )
  // 单/双击区分:运行中 → 单击查看(延迟 220ms 等可能的第二击)、双击再跑一个;未运行 → 单击直接运行。
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 同一条命令的「真正启动」冷却窗:手快误双击会落在窗内被吞掉,只开一个;
  // 而「先启动 → 进入运行中 → 再双击加开」这种有意连开,间隔天然 > 窗口,不受影响。
  // 不依赖 running prop 何时翻转,所以 spawn 再快也稳。
  const lastRunAt = useRef(0)
  const fireRun = () => {
    const now = Date.now()
    if (now - lastRunAt.current < 350) return // 冷却中:吞掉意外的第二次启动
    lastRunAt.current = now
    onRun()
  }
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    },
    [],
  )
  const handleClick = () => {
    if (!running) {
      fireRun()
      return
    }
    if (clickTimer.current) return // 第二次 click(双击的一部分)忽略,交给 onDoubleClick
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      onView?.()
    }, 220)
  }
  const handleDouble = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    fireRun()
  }

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
      <div
        className={'cmd' + (running ? ' running' : '')}
        onClick={handleClick}
        onDoubleClick={handleDouble}
        title={running ? '单击查看 · 双击再次运行' : undefined}
      >
        <span className={'run-icon' + (running ? ' on' : '')}>{running ? '●' : '▶'}</span>
        {origin === 'ai' && <span className="cmd-ai-tag" title="AI 识别">✨</span>}
        <span className="cmd-name">{display}</span>
        {source && <span className="cmd-source">{source}</span>}
        {running && <span className="cmd-running-tag">运行中</span>}
        {configured && (
          <button className="explain-btn" aria-label="AI 解释这条命令" onClick={toggleExplain}>
            {explain ? '×' : '?'}
          </button>
        )}
        {onEdit && (
          <button
            className="edit-btn"
            aria-label="编辑这条命令"
            title="编辑命令"
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
          >
            ✎
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
  multiSource,
  onRun,
  onView,
  runningLabels,
}: {
  group: PrefixGroup
  dirName: string
  path: string
  multiSource: boolean
  onRun: RunFn
  onView: (label: string) => void
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
              source={multiSource ? it.source : undefined}
              running={runningLabels.has(`${dirName}:${it.name}`)}
              onRun={() => onRun(`${dirName}:${it.name}`, path, it.command)}
              onView={() => onView(`${dirName}:${it.name}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DirNode({
  projectId,
  path,
  manualCommands,
  onRun,
  onView,
  onOpenTerminal,
  onOpenVscode,
  runningLabels,
  onEditManual,
  onRemoveManual,
  onRemove,
}: {
  projectId: string
  path: string
  manualCommands: CommandEntry[]
  onRun: RunFn
  onView: (label: string) => void
  onOpenTerminal: (cwd: string) => void
  onOpenVscode: (path: string) => void
  runningLabels: Set<string>
  onEditManual: (cmd: CommandEntry) => void
  onRemoveManual: (cmd: CommandEntry) => void
  onRemove?: () => void
}) {
  const [commands, setCommands] = useState<Command[]>([])
  // 该目录检测到的工具链(pnpm / cargo / go…)。包管理器是项目级属性,
  // 在目录头集中展示一次;只有多工具链(如 go+make)时才下放到每条命令区分。
  const [sources, setSources] = useState<string[]>([])
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

  const addManualCommand = useStore((s) => s.addManualCommand)
  const [proposing, setProposing] = useState(false)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [proposeErr, setProposeErr] = useState('')
  // 发送前确认:本地采集到的上下文,先让用户勾选要发哪些文件,再调 LLM。
  const [pendingCtx, setPendingCtx] = useState<ProjectContext | null>(null)

  // 第一步:本地采集(纯本地,不联网)→ 打开"发送前确认"弹窗。
  const runAiRecognize = async () => {
    setProposing(true)
    setProposeErr('')
    try {
      const ctx = await collectContext(path)
      setPendingCtx(ctx)
    } catch (e) {
      setProposeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProposing(false)
    }
  }

  // 第二步:用户确认要发的文件 → 只把勾选的文件交给 LLM(目录树照旧全发)。
  const startRecognize = async (selectedRelPaths: string[]) => {
    if (!pendingCtx) return
    const allow = new Set(selectedRelPaths)
    const filtered: ProjectContext = {
      ...pendingCtx,
      files: pendingCtx.files.filter((f) => allow.has(f.relPath)),
    }
    setPendingCtx(null)
    setProposing(true)
    setProposeErr('')
    try {
      const list = await proposeCommands(filtered)
      setProposals(list)
    } catch (e) {
      setProposeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setProposing(false)
    }
  }

  // 把相对 cwd 解析为绝对路径(空=绑定根)。
  const joinCwd = (rel: string) => {
    const r = rel.trim().replace(/^\.?\/?/, '')
    if (!r) return path
    return `${path.replace(/\/+$/, '')}/${r}`
  }

  const landProposals = (selected: Proposal[]) => {
    for (const p of selected) {
      addManualCommand(projectId, p.name, joinCwd(p.cwd), p.command, 'ai')
    }
    setProposals(null)
  }

  // 提议是否已存在于本目录命令(标签+命令+绝对 cwd 全同)——与 store 去重键一致,
  // 弹窗据此标「已添加」并默认不勾。命令相同但标签不同的视为不同命令,不算已添加。
  const proposalExists = (p: Proposal) =>
    manualCommands.some(
      (m) => m.label === p.name && m.command === p.command && m.cwd === joinCwd(p.cwd),
    )

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    // path 变了(用户改目录绑定):清掉上一个目录残留的 AI 提议状态,避免跨目录串扰。
    setProposals(null)
    setProposeErr('')
    setProposing(false)
    setPendingCtx(null)

    const applyScan = (r: ScanResult) => {
      if (!active) return
      setCommands(r.commands)
      setSources(r.detectedSources)
      if (!r.dirExists) {
        setWarn('目录不存在或无访问权限(检查 macOS 系统设置 → 隐私与安全性 → 文件和文件夹 / 完整磁盘访问)')
      } else if (r.detectedSources.length === 0) {
        setWarn('此目录无可识别的项目（package.json / Cargo.toml / Makefile / go.mod / pom.xml 等）')
      } else if (r.commands.length === 0) {
        setWarn('检测到项目但无可运行命令')
      } else {
        setWarn('')
      }
    }

    // 初始扫一次
    scanDir(path).then(applyScan)

    // 监听该目录 package.json 变更:后端防抖后 emit pkg-changed → 重扫。
    // 事件是全局广播,按 payload.path 匹配自己,避免多目录互相串扰。
    watchDir(path).catch(() => {})
    listen<{ path: string }>('pkg-changed', (e) => {
      if (e.payload.path === path) scanDir(path).then(applyScan)
    }).then((u) => {
      if (active) unlisten = u
      else u() // 已卸载:listen 的 Promise 晚于 cleanup 解析时,立即注销避免泄漏
    })

    return () => {
      active = false
      unlisten?.()
      unwatchDir(path).catch(() => {})
    }
  }, [path])

  // AI 智能分组：开启后拉取并缓存；失败回退启发式
  useEffect(() => {
    if (!aiMode || commands.length === 0) return
    let cancelled = false
    setAiState('loading')
    smartGroup(commands)
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
  }, [aiMode, commands])

  const dirName = path.split('/').filter(Boolean).pop() || path
  const categories = aiMode && aiCats ? aiCats : categorize(commands)
  const dirRunning = commands.filter((s) => runningLabels.has(`${dirName}:${s.name}`)).length
  // 单一工具链时,包管理器在目录头展示一次即可,不在每条命令重复(噪声);
  // 多工具链(go+make / npm+composer)才下放到命令级区分来源。
  const multiSource = sources.length > 1

  return (
    <div className="dir">
      {/* 用原生 title,不用 HeroUI Tooltip —— 后者的 overlay 会拦截列表区的点击和滚动 */}
      <div className="dir-path" onClick={() => setOpen((o) => !o)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="dir-icon">📁</span>
        <span className="dir-name">{dirName}</span>
        {sources.map((s) => (
          <span className="dir-source" key={s}>{s}</span>
        ))}
        {commands.length + manualCommands.length > 0 && (
          <span className="dir-count">{commands.length + manualCommands.length}</span>
        )}
        {dirRunning > 0 && <span className="activity-dot" />}
        {/* 右侧操作区:开终端 / VSCode / 删除。stopPropagation 避免点按钮误触发目录展开。 */}
        <span className="dir-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="dir-act-btn"
            aria-label="在此目录打开终端"
            title="在此目录打开终端"
            onClick={() => onOpenTerminal(path)}
          >
            <TerminalIcon />
          </button>
          <button
            type="button"
            className="dir-act-btn"
            aria-label="用 VSCode 打开此目录"
            title="用 VSCode 打开此目录"
            onClick={() => onOpenVscode(path)}
          >
            <VscodeIcon />
          </button>
          {onRemove && <DeleteButton title="删除此目录绑定" onClick={onRemove} />}
        </span>
      </div>

      {/* git chip 单独一行(缩进对齐目录名),避免和目录名挤一行把名字压折 */}
      <GitChip path={path} />

      {open && (
        <div className="dir-body">
          {configured && (
            <div className="dir-toolbar">
              {commands.length > 0 && (
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
              )}
              <button
                className={'ai-btn' + (commands.length === 0 ? ' suggest' : '')}
                disabled={proposing}
                onClick={runAiRecognize}
                aria-label="用 AI 读项目结构,提议可运行命令"
              >
                {proposing ? (
                  <>
                    <span className="ai-spinner" /> AI 识别中…
                  </>
                ) : (
                  '✨ 让 AI 识别'
                )}
              </button>
            </div>
          )}
          {proposeErr && <div className="warn">{proposeErr}</div>}
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
                  multiSource={multiSource}
                  onRun={onRun}
                  onView={onView}
                  runningLabels={runningLabels}
                />
              ))}
              {cat.loose.map((it: CmdLeaf) => (
                <CmdRow
                  key={it.name}
                  display={it.name}
                  command={it.command}
                  source={multiSource ? it.source : undefined}
                  running={runningLabels.has(`${dirName}:${it.name}`)}
                  onRun={() => onRun(`${dirName}:${it.name}`, path, it.command)}
                  onView={() => onView(`${dirName}:${it.name}`)}
                />
              ))}
            </div>
          ))}
          {/* 手动 / AI 识别落地的命令:按 cwd 归到本目录下(项目级 orphan 在别处渲染) */}
          {manualCommands.length > 0 && (
            <div className="cat">
              <div className="cat-label">手动 / AI</div>
              {manualCommands.map((m) => (
                <CmdRow
                  key={m.id}
                  display={m.label}
                  command={`${m.command} · ${m.cwd}`}
                  origin={m.origin}
                  running={runningLabels.has(m.label)}
                  onRun={() => onRun(m.label, m.cwd, m.command)}
                  onView={() => onView(m.label)}
                  onEdit={() => onEditManual(m)}
                  onRemove={() => onRemoveManual(m)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {pendingCtx !== null && (
        <AiContextModal
          context={pendingCtx}
          onConfirm={startRecognize}
          onCancel={() => setPendingCtx(null)}
        />
      )}
      {proposals !== null && (
        <AiProposeModal
          proposals={proposals}
          isExisting={proposalExists}
          onConfirm={landProposals}
          onCancel={() => setProposals(null)}
        />
      )}
    </div>
  )
}

/// 终端图标(lucide square-terminal 风格,描边)。
function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </svg>
  )
}

/// VSCode 官方 logo(单色填充 currentColor)。
function VscodeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  )
}
