import { useEffect, useState } from 'react'
import { Tooltip } from '@heroui/react'
import { useStore } from '../state/store'
import { scanDir } from '../lib/ipc'
import type { Script } from '../lib/types'
import { categorize, type CmdLeaf, type PrefixGroup } from '../lib/grouping'
import { InputModal } from './InputModal'
import { ShimmerButton } from './ui/ShimmerButton'
import { BlurFade } from './ui/BlurFade'

interface RunFn {
  (label: string, cwd: string, command: string): void
}

type Pending =
  | { kind: 'project' }
  | { kind: 'dir'; projectId: string }
  | { kind: 'manual'; projectId: string }
  | null

export function Sidebar({ onRun }: { onRun: RunFn }) {
  const { config, addProject, addDirectory, addManualCommand, removeProject, setActiveProject } =
    useStore()
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
            <div className="project-head">
              <span
                className="project-name"
                onClick={() => setActiveProject(p.id)}
                title="设为当前项目(右侧工作区跟随)"
              >
                {p.name}
                {runningByProject(p.id) > 0 && (
                  <span className="project-running" title={`${runningByProject(p.id)} 个在跑`}>
                    {runningByProject(p.id)}
                  </span>
                )}
              </span>
              <span className="project-actions">
                <Tooltip>
                  <Tooltip.Trigger>
                    <button
                      className="pill-btn"
                      onClick={() => setPending({ kind: 'dir', projectId: p.id })}
                    >
                      +目录
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>绑定含 package.json 的目录</Tooltip.Content>
                </Tooltip>
                <Tooltip>
                  <Tooltip.Trigger>
                    <button
                      className="pill-btn"
                      onClick={() => setPending({ kind: 'manual', projectId: p.id })}
                    >
                      +命令
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>新增手动命令</Tooltip.Content>
                </Tooltip>
                <Tooltip>
                  <Tooltip.Trigger>
                    <button className="pill-btn danger" onClick={() => removeProject(p.id)}>
                      ✕
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Content>移除项目</Tooltip.Content>
                </Tooltip>
              </span>
            </div>

            {p.directories.map((d) => (
              <DirNode key={d.id} path={d.path} onRun={onRun} runningLabels={runningLabels} />
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
          fields={[{ key: 'name', label: '项目名', placeholder: '如 GYJ2 monorepo' }]}
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
            { key: 'label', label: '标签(可选)', placeholder: '不填则用命令本身' },
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

/// 单条命令行。running → 高亮 + 脉冲圆点。
function CmdRow({
  display,
  command,
  running,
  onRun,
}: {
  display: string
  command: string
  running: boolean
  onRun: () => void
}) {
  return (
    <Tooltip>
      <Tooltip.Trigger>
        <div className={'cmd' + (running ? ' running' : '')} onClick={onRun}>
          <span className={'run-icon' + (running ? ' on' : '')}>{running ? '●' : '▶'}</span>
          <span className="cmd-name">{display}</span>
          {running && <span className="cmd-running-tag">运行中</span>}
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content>{command}</Tooltip.Content>
    </Tooltip>
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
        {runningCount > 0 && <span className="activity-dot" title={`${runningCount} 个在跑`} />}
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
}: {
  path: string
  onRun: RunFn
  runningLabels: Set<string>
}) {
  const [scripts, setScripts] = useState<Script[]>([])
  const [warn, setWarn] = useState('')
  const [open, setOpen] = useState(false) // 目录默认收起

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

  const dirName = path.split('/').filter(Boolean).pop() || path
  const categories = categorize(scripts)
  const dirRunning = scripts.filter((s) => runningLabels.has(`${dirName}:${s.name}`)).length

  return (
    <div className="dir">
      <Tooltip>
        <Tooltip.Trigger>
          <div className="dir-path" onClick={() => setOpen((o) => !o)}>
            <span className="chevron">{open ? '▾' : '▸'}</span>
            <span className="dir-icon">📁</span>
            <span className="dir-name">{dirName}</span>
            {scripts.length > 0 && <span className="dir-count">{scripts.length}</span>}
            {dirRunning > 0 && <span className="activity-dot" title={`${dirRunning} 个在跑`} />}
          </div>
        </Tooltip.Trigger>
        <Tooltip.Content>{path}</Tooltip.Content>
      </Tooltip>

      {open && (
        <div className="dir-body">
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
