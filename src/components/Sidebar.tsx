import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { scanDir } from '../lib/ipc'
import type { Project, Script } from '../lib/types'
import { InputModal } from './InputModal'

interface RunFn {
  (label: string, cwd: string, command: string): void
}

type Pending =
  | { kind: 'project' }
  | { kind: 'dir'; projectId: string }
  | { kind: 'manual'; projectId: string }
  | null

export function Sidebar({ onRun }: { onRun: RunFn }) {
  const { config, addProject, addDirectory, addManualCommand, removeProject } = useStore()
  const [pending, setPending] = useState<Pending>(null)

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="logo">⚓ Quay</span>
        <button className="add-btn" onClick={() => setPending({ kind: 'project' })}>
          + 项目
        </button>
      </div>

      {config.projects.length === 0 && (
        <div className="empty-hint">还没有项目。点「+ 项目」开始,再给项目绑定目录或手动命令。</div>
      )}

      {config.projects.map((p) => (
        <ProjectNode
          key={p.id}
          project={p}
          onRun={onRun}
          onAddDir={() => setPending({ kind: 'dir', projectId: p.id })}
          onAddManual={() => setPending({ kind: 'manual', projectId: p.id })}
          onRemove={() => removeProject(p.id)}
        />
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
            { key: 'cwd', label: '工作目录 cwd(绝对路径)', placeholder: '/Users/you/code/api' },
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

function ProjectNode({
  project: p,
  onRun,
  onAddDir,
  onAddManual,
  onRemove,
}: {
  project: Project
  onRun: RunFn
  onAddDir: () => void
  onAddManual: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="project">
      <div className="project-head">
        <span className="project-name" onClick={() => setOpen((o) => !o)}>
          <span className="caret">{open ? '▾' : '▸'}</span> {p.name}
        </span>
        <span className="project-actions">
          <button onClick={onAddDir}>+目录</button>
          <button onClick={onAddManual}>+命令</button>
          <button className="danger" onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>

      {open && (
        <>
          {p.directories.map((d) => (
            <DirNode key={d.id} path={d.path} onRun={onRun} />
          ))}
          {p.manualCommands.map((m) => (
            <div key={m.id} className="cmd manual" onClick={() => onRun(m.label, m.cwd, m.command)}>
              <span className="run-icon">▶</span> {m.label}
              <span className="cmd-hint">{m.command}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function DirNode({ path, onRun }: { path: string; onRun: RunFn }) {
  const [scripts, setScripts] = useState<Script[]>([])
  const [warn, setWarn] = useState('')
  const [open, setOpen] = useState(true)

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

  return (
    <div className="dir">
      <div className="dir-path" title={path} onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span> 📁 {dirName}
      </div>
      {open && (
        <>
          {warn && <div className="warn">{warn}</div>}
          {scripts.map((s) => (
            <div
              key={s.name}
              className="cmd"
              onClick={() => onRun(`${dirName}:${s.name}`, path, `npm run ${s.name}`)}
              title={s.command}
            >
              <span className="run-icon">▶</span> {s.name}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
