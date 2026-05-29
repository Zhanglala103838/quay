import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { RunningBar } from './components/RunningBar'
import { OrphanDialog } from './components/OrphanDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import { AuroraBackground } from './components/ui/AuroraBackground'
import { SettingsButton } from './components/SettingsButton'
import { SidebarToggle } from './components/SidebarToggle'
import { ContextMenu } from './components/ContextMenu'
import { listen } from '@tauri-apps/api/event'
import { useStore } from './state/store'
import { useSettings } from './state/settings'
import { applyUiFontVars } from './lib/fonts'
import { runCommand, attachRun, listRuns, listOrphans } from './lib/ipc'
import { termRegistry } from './lib/termRegistry'
import { notifyCommandDone } from './lib/notify'
import type { Orphan, RunEvent } from './lib/types'
import quayLogo from './assets/quay-logo.png'
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
    else {
      applyRunEvent(runId, e)
      if (e.type === 'exit') {
        const label = useStore.getState().runs.find((r) => r.runId === runId)?.label ?? '命令'
        notifyCommandDone(label, e.code)
      }
    }
  }

  // 界面(非终端)字体:把选择写进 CSS 变量(--font-mono / --font-display),挂载即套用持久值。
  const uiLatin = useSettings((s) => s.render.uiLatin)
  const uiCJK = useSettings((s) => s.render.uiCJK)
  useEffect(() => {
    applyUiFontVars(uiLatin, uiCJK)
  }, [uiLatin, uiCJK])

  const [orphans, setOrphans] = useState<Orphan[]>([])
  // 侧栏折叠:仅隐藏项目树(保留拖拽宽度),状态持久化;折叠后切换按钮仍在标题栏可点回。
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('quay.sidebarCollapsed') === '1')
  const toggleSidebar = () =>
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem('quay.sidebarCollapsed', next ? '1' : '0')
      return next
    })

  // 原生菜单/快捷键事件(后端 emit):切侧栏 ⌘B、清屏当前终端 ⌘K。设置 ⌘, 由 SettingsButton 监听。
  useEffect(() => {
    const uns: Array<() => void> = []
    listen('menu-toggle-sidebar', () => toggleSidebar()).then((u) => uns.push(u))
    listen('menu-clear-term', () => {
      const aid = useStore.getState().activeRunId
      if (aid) termRegistry[aid]?.clear()
    }).then((u) => uns.push(u))
    return () => uns.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    upsertRun({ runId, label, cwd, command, status: 'running', exitCode: null }, true)
    runCommand({ runId, label, cwd, command }, handler(runId)).catch((err) => {
      write(runId, `\r\n[启动失败] ${err}\r\n`)
      applyRunEvent(runId, { type: 'exit', code: -1 })
    })
  }

  return (
    <>
      <AuroraBackground />
      <div className={'app' + (collapsed ? ' sidebar-collapsed' : '')}>
        {/* 沉浸式拖拽顶栏：替代 macOS 原生标题栏，给交通灯留位 + 支持拖动窗口 */}
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-left">
            <SidebarToggle collapsed={collapsed} onToggle={toggleSidebar} />
          </div>
          <span className="titlebar-brand" data-tauri-drag-region>
            <img src={quayLogo} className="logo-mark" alt="" draggable={false} data-tauri-drag-region />
            <span className="gradient-text">Quay</span>
          </span>
          <div className="titlebar-right">
            <SettingsButton />
          </div>
        </div>
        <div className="main">
          <Sidebar onRun={onRun} />
          <Workspace writers={writers} />
        </div>
        <RunningBar />
        <OrphanDialog orphans={orphans} onClose={() => setOrphans([])} />
        <ConfirmDialog />
      </div>
      <ContextMenu />
    </>
  )
}
