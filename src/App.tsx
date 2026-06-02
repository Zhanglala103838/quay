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
import { useStore, type RunState } from './state/store'
import { useSettings } from './state/settings'
import { applyUiFontVars } from './lib/fonts'
import { runCommand, attachRun, listRuns, listOrphans, stopCommand, closeCommand, openInVscode, devPortBusy } from './lib/ipc'
import { askConfirm } from './state/confirm'
import { termRegistry } from './lib/termRegistry'
import { notifyCommandDone } from './lib/notify'
import { showToast } from './state/toast'
import { Toast } from './components/Toast'
import type { CommandGroup, Orphan, RunEvent } from './lib/types'
import quayLogo from './assets/quay-logo.png'
import './App.css'

export default function App() {
  const { load, upsertRun, applyRunEvent, closeRun } = useStore()
  const writers = useRef<Record<string, (s: string) => void>>({})
  // 终端未挂载时暂存输出,挂载后首次 write 时回灌(支撑 reload 历史回放)。
  const pending = useRef<Record<string, string[]>>({})
  // 正在重启的 runId 集合:防连点 ↻ 开出多个新实例。
  const restarting = useRef<Set<string>>(new Set())

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

  // 终端 writer 就绪即回灌暂存输出。否则:交互 shell 的首个 prompt 常早于终端挂载到达 → 卡进
  // pending,而静默 shell 没有后续输出来触发上面 write() 的懒回灌 → 一直空白到用户打字才显出。
  const flushPendingFor = (runId: string) => {
    const w = writers.current[runId]
    const buf = pending.current[runId]
    if (w && buf?.length) {
      buf.forEach((b) => w(b))
      delete pending.current[runId]
    }
  }
  useEffect(() => {
    const onReady = (e: Event) => flushPendingFor((e as CustomEvent<string>).detail)
    window.addEventListener('quay:writer-ready', onReady)
    return () => window.removeEventListener('quay:writer-ready', onReady)
  }, [])

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

  // 窗口重获焦点 → 触发 git 刷新(§5)。只在 blur→focus 上升沿 bump，
  // 避免启动即 bump(首拉已由各 useEffect 自带)与失焦误触发。
  useEffect(() => {
    let focused = true
    const uns: Array<() => void> = []
    listen('tauri://blur', () => {
      focused = false
    }).then((u) => uns.push(u))
    listen('tauri://focus', () => {
      if (!focused) {
        focused = true
        useStore.getState().bumpGitRefresh()
      }
    }).then((u) => uns.push(u))
    return () => uns.forEach((u) => u())
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
          interactive: r.interactive,
        }),
      )
      // 延迟 attach,等终端挂载;history 经 pending 兜底回灌。
      setTimeout(() => {
        runs.forEach((r) => attachRun(r.runId, handler(r.runId)))
      }, 150)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const onRun = (label: string, cwd: string, command: string, interactive = false) => {
    const runId = uuid()
    upsertRun({ runId, label, cwd, command, status: 'running', exitCode: null, interactive }, true)
    runCommand({ runId, label, cwd, command, interactive }, handler(runId)).catch((err) => {
      write(runId, `\r\n[启动失败] ${err}\r\n`)
      applyRunEvent(runId, { type: 'exit', code: -1 })
    })
  }

  // 启动前探测(仅用户点击单条命令时):tauri dev 类命令会让窗口加载 devUrl,
  // 若声明的 dev 端口此刻已被别的进程占住,继续启动会加载到错的应用 —— 弹一次性确认。
  // 边界:只认 `tauri dev`(唯一读 devUrl 的命令);端口空闲/未声明端口/探测失败 → 不打扰,直接跑。
  // restart/组启动/开终端走原始 onRun,不经此探测(它们是显式意图,别重复 nag)。
  const onRunGuarded = async (label: string, cwd: string, command: string, interactive = false) => {
    if (/tauri\s+dev\b/i.test(command)) {
      try {
        const busy = await devPortBusy(cwd)
        if (busy) {
          askConfirm({
            title: `端口 ${busy.port} 已被占用`,
            message: `进程「${busy.process}」(pid ${busy.pid}) 正在监听 ${busy.port}。继续启动会让本项目的 Tauri 窗口加载到该端口上的应用(很可能是另一个项目)。建议先停掉占用方,或给其中一个项目改 dev 端口。`,
            confirmText: '仍然启动',
            onConfirm: () => onRun(label, cwd, command, interactive),
          })
          return
        }
      } catch {
        // 探测失败(无 lsof 等)不阻塞启动
      }
    }
    onRun(label, cwd, command, interactive)
  }

  // 一键并行跑整组:逐条 onRun(非阻塞 → 各开各的 tab)。已在运行的成员跳过,
  // 避免把跑着的 dev server 再撞起来吃 EADDRINUSE。
  const runGroup = (group: CommandGroup) => {
    const running = new Set(
      useStore.getState().runs.filter((r) => r.status === 'running').map((r) => r.label),
    )
    let started = 0
    let skipped = 0
    for (const m of group.members) {
      if (running.has(m.label)) {
        skipped++
        continue
      }
      onRun(m.label, m.cwd, m.command)
      started++
    }
    if (started === 0 && skipped > 0) showToast(`组「${group.name}」: ${skipped} 条都在运行中`)
    else showToast(`组「${group.name}」: 已启动 ${started}${skipped > 0 ? ` · 跳过 ${skipped} 运行中` : ''}`)
  }

  // 在某目录开一个可输入的交互终端(zsh -li),归到该项目右侧终端区。每次点都新开一个。
  const onOpenTerminal = (cwd: string) => {
    const dirName = cwd.split('/').filter(Boolean).pop() || cwd
    onRun(`${dirName} ⌨`, cwd, 'zsh -li', true)
  }

  // 用电脑的 VSCode 打开该目录;没装则浮层提示。
  const onOpenVscode = (path: string) => {
    openInVscode(path).catch(() => showToast('未检测到 VSCode'))
  }

  // 重新启动:用新 runId 起同一条命令替换旧格。运行中要先停、等进程真正退出
  // (端口/资源释放)再起,避免 dev server 重启撞 EADDRINUSE;已退出则直接重跑。
  const restartRun = (run: RunState) => {
    if (restarting.current.has(run.runId)) return // 防连点开多个
    const { runId, label, cwd, command, interactive } = run
    const relaunch = () => {
      onRun(label, cwd, command, interactive) // 新 runId 成为当前激活格
      closeCommand(runId).catch(() => {}) // 释放后端旧 run 资源
      closeRun(runId) // 移除旧格(activeRunId 已是新格,不受影响)
      restarting.current.delete(runId)
    }
    if (run.status !== 'running') {
      relaunch()
      return
    }
    restarting.current.add(runId)
    stopCommand(runId)
    const startedAt = Date.now()
    // 轮询 store:旧 run 翻成 exited(或被清掉)= 进程已死、端口已释放,再重跑。8s 兜底。
    const timer = setInterval(() => {
      const cur = useStore.getState().runs.find((r) => r.runId === runId)
      if (!cur || cur.status === 'exited' || Date.now() - startedAt > 8000) {
        clearInterval(timer)
        relaunch()
      }
    }, 120)
  }

  return (
    <>
      <AuroraBackground />
      <div className={'app' + (collapsed ? ' sidebar-collapsed' : '')}>
        {/* 沉浸式拖拽顶栏：替代 macOS 原生标题栏，给交通灯留位。
            拖窗由原生 NSView 处理(见 src-tauri/src/lib.rs install_titlebar_drag),
            不再用 data-tauri-drag-region——后者是 JS+IPC,命中上游 #12597 拖完卡几秒,
            且整窗 movableByWindowBackground 会吞掉终端拖拽选区。 */}
        <div className="titlebar">
          <div className="titlebar-left">
            <SidebarToggle collapsed={collapsed} onToggle={toggleSidebar} />
          </div>
          <span className="titlebar-brand">
            <img src={quayLogo} className="logo-mark" alt="" draggable={false} />
            <span className="gradient-text">Quay</span>
          </span>
          <div className="titlebar-right">
            <SettingsButton />
          </div>
        </div>
        <div className="main">
          <Sidebar onRun={onRunGuarded} onRunGroup={runGroup} onOpenTerminal={onOpenTerminal} onOpenVscode={onOpenVscode} />
          <Workspace writers={writers} onRestart={restartRun} />
        </div>
        <RunningBar />
        <OrphanDialog orphans={orphans} onClose={() => setOrphans([])} />
        <ConfirmDialog />
        <Toast />
      </div>
      <ContextMenu />
    </>
  )
}
