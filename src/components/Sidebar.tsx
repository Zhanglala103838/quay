import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { scanDir } from '../lib/ipc'
import type { Script } from '../lib/types'

interface RunFn {
  (label: string, cwd: string, command: string): void
}

export function Sidebar({ onRun }: { onRun: RunFn }) {
  const { config, addProject, addDirectory, addManualCommand, removeProject } = useStore()

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="logo">⚓ Quay</span>
        <button
          className="add-btn"
          onClick={() => {
            const n = prompt('项目名(如 GYJ2 monorepo)')
            if (n) addProject(n)
          }}
        >
          + 项目
        </button>
      </div>

      {config.projects.length === 0 && (
        <div className="empty-hint">还没有项目。点「+ 项目」开始,再给项目绑定目录或手动命令。</div>
      )}

      {config.projects.map((p) => (
        <div key={p.id} className="project">
          <div className="project-head">
            <span className="project-name">{p.name}</span>
            <span className="project-actions">
              <button
                onClick={() => {
                  const d = prompt('目录绝对路径(含 package.json)')
                  if (d) addDirectory(p.id, d.trim())
                }}
              >
                +目录
              </button>
              <button
                onClick={() => {
                  const cwd = prompt('工作目录 cwd(绝对路径)')
                  if (!cwd) return
                  const cmd = prompt('命令(如 php think run)')
                  if (!cmd) return
                  const lb = prompt('标签', cmd) || cmd
                  addManualCommand(p.id, lb, cwd.trim(), cmd.trim())
                }}
              >
                +命令
              </button>
              <button className="danger" onClick={() => removeProject(p.id)}>
                ✕
              </button>
            </span>
          </div>

          {p.directories.map((d) => (
            <DirNode key={d.id} path={d.path} onRun={onRun} />
          ))}

          {p.manualCommands.map((m) => (
            <div key={m.id} className="cmd manual" onClick={() => onRun(m.label, m.cwd, m.command)}>
              <span className="run-icon">▶</span> {m.label}
              <span className="cmd-hint">{m.command}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function DirNode({ path, onRun }: { path: string; onRun: RunFn }) {
  const [scripts, setScripts] = useState<Script[]>([])
  const [warn, setWarn] = useState('')

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
      <div className="dir-path" title={path}>
        📁 {dirName}
      </div>
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
    </div>
  )
}
