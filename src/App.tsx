import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Sidebar } from './components/Sidebar'
import { RunTabs } from './components/RunTabs'
import { RunningBar } from './components/RunningBar'
import { OrphanDialog } from './components/OrphanDialog'
import { AuroraBackground } from './components/ui/AuroraBackground'
import { useStore } from './state/store'
import { runCommand, attachRun, listRuns, listOrphans } from './lib/ipc'
import type { Orphan, RunEvent } from './lib/types'
import './App.css'

export default function App() {
  const { load, upsertRun, applyRunEvent } = useStore()
  const writers = useRef<Record<string, (s: string) => void>>({})
  // 终端未挂载时暂存输出,挂载后首次 write 时回灌(支撑 reload 历史回放)。
  const pending = useRef<Record<string, string[]>>({})

  const write = (runId: string, s: string) => {
    const w = writers.current[runId]
    if (w) {
      const buf = pending.current[runId]
      if (buf?.length) {
        buf.forEach((b) => w(b))
        delete pending.current[runId]
      }
      w(s)
    } else {
      ;(pending.current[runId] ||= []).push(s)
    }
  }

  const handler = (runId: string) => (e: RunEvent) => {
    if (e.type === 'output') write(runId, e.chunk)
    else applyRunEvent(runId, e)
  }

  const [orphans, setOrphans] = useState<Orphan[]>([])

  useEffect(() => {
    // 先 load(config 就绪)再恢复 run —— upsertRun 要靠 config 按 cwd 推断 projectId。
    ;(async () => {
      await load()
      listOrphans().then(setOrphans)
      const runs = await listRuns()
      runs.forEach((r) =>
        upsertRun({
          runId: r.runId,
          label: r.label,
          cwd: r.cwd,
          command: r.command,
          status: r.status,
          exitCode: r.exitCode,
        }),
      )
      // 延迟 attach,等终端挂载;history 经 pending 兜底回灌。
      setTimeout(() => {
        runs.forEach((r) => attachRun(r.runId, handler(r.runId)))
      }, 150)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const onRun = (label: string, cwd: string, command: string) => {
    const runId = uuid()
    upsertRun({ runId, label, cwd, command, status: 'running', exitCode: null })
    runCommand({ runId, label, cwd, command }, handler(runId)).catch((err) => {
      write(runId, `\r\n[启动失败] ${err}\r\n`)
      applyRunEvent(runId, { type: 'exit', code: -1 })
    })
  }

  return (
    <>
      <AuroraBackground />
      <div className="app">
        {/* 沉浸式拖拽顶栏：替代 macOS 原生标题栏，给交通灯留位 + 支持拖动窗口 */}
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-brand" data-tauri-drag-region>
            <span className="logo-anchor">⚓</span>
            <span className="gradient-text">Quay</span>
          </span>
        </div>
        <div className="main">
          <Sidebar onRun={onRun} />
          <RunTabs writers={writers} />
        </div>
        <RunningBar />
        <OrphanDialog orphans={orphans} onClose={() => setOrphans([])} />
      </div>
    </>
  )
}
