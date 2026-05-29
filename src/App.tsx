import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Sidebar } from './components/Sidebar'
import { RunTabs } from './components/RunTabs'
import { RunningBar } from './components/RunningBar'
import { OrphanDialog } from './components/OrphanDialog'
import { useStore } from './state/store'
import { runCommand, listOrphans } from './lib/ipc'
import type { Orphan } from './lib/types'
import './App.css'

export default function App() {
  const { load, upsertRun, applyRunEvent } = useStore()
  const writers = useRef<Record<string, (s: string) => void>>({})
  const [orphans, setOrphans] = useState<Orphan[]>([])

  useEffect(() => {
    load()
    listOrphans().then(setOrphans)
  }, [load])

  const onRun = (label: string, cwd: string, command: string) => {
    const runId = uuid()
    upsertRun({ runId, label, cwd, command, status: 'running', exitCode: null })
    runCommand({ runId, label, cwd, command }, (e) => {
      if (e.type === 'output') writers.current[runId]?.(e.chunk)
      else applyRunEvent(runId, e)
    }).catch((err) => {
      writers.current[runId]?.(`\r\n[启动失败] ${err}\r\n`)
      applyRunEvent(runId, { type: 'exit', code: -1 })
    })
  }

  return (
    <div className="app">
      <div className="main">
        <Sidebar onRun={onRun} />
        <RunTabs writers={writers} />
      </div>
      <RunningBar />
      <OrphanDialog orphans={orphans} onClose={() => setOrphans([])} />
    </div>
  )
}
