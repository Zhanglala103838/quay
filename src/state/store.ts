import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { Config, RunEvent } from '../lib/types'
import { getConfig, setConfig } from '../lib/ipc'
import { clampPage, pageOf, type Layout } from '../lib/paging'

const LAST_PROJECT_KEY = 'quay.activeProjectId'

const LAYOUT_KEY = (pid: string) => `quay.layout.${pid}`

/// 读某项目持久化的布局(单/双/四格);无记录或非法 → 单格。
function loadLayout(pid: string | null): Layout {
  if (!pid) return 1
  const v = Number(localStorage.getItem(LAYOUT_KEY(pid)))
  return v === 2 || v === 4 ? v : 1
}

/// 工作区可见 run:当前项目 + 未归属(沿用 RunTabs 既有过滤,保持顺序)。
function visibleRuns(runs: RunState[], activeProjectId: string | null): RunState[] {
  return runs.filter((r) => !activeProjectId || r.projectId === activeProjectId || !r.projectId)
}

export interface RunState {
  runId: string
  label: string
  cwd: string
  command: string
  status: 'running' | 'exited'
  exitCode: number | null
  projectId: string // 归属项目(由 cwd 推断);'' = 未归属
  interactive: boolean // true = 可输入交互终端(zsh -li);false = 只读命令监控
}

/// 由 run 的 cwd 反查它属于哪个项目(匹配目录路径或手动命令 cwd)。
function inferProjectId(config: Config, cwd: string): string {
  for (const p of config.projects) {
    if (p.directories.some((d) => d.path === cwd)) return p.id
    if (p.manualCommands.some((m) => m.cwd === cwd)) return p.id
  }
  return ''
}

interface Store {
  config: Config
  runs: RunState[]
  activeRunId: string | null
  activeProjectId: string | null
  layout: Layout
  currentPage: number
  activeGitPath: string | null
  gitRefreshTick: number
  load: () => Promise<void>
  persist: () => Promise<void>
  addProject: (name: string) => void
  addDirectory: (projectId: string, path: string) => void
  removeDirectory: (projectId: string, dirId: string) => void
  addManualCommand: (projectId: string, label: string, cwd: string, command: string, origin?: 'ai') => void
  updateManualCommand: (
    projectId: string,
    cmdId: string,
    label: string,
    cwd: string,
    command: string,
  ) => void
  removeManualCommand: (projectId: string, cmdId: string) => void
  removeProject: (id: string) => void
  setActiveProject: (id: string) => void
  setLayout: (n: Layout) => void
  setPage: (n: number) => void
  upsertRun: (r: Omit<RunState, 'projectId'> & { projectId?: string }, focus?: boolean) => void
  applyRunEvent: (runId: string, e: RunEvent) => void
  setActive: (runId: string | null) => void
  closeRun: (runId: string) => void
  openGit: (path: string) => void
  closeGit: () => void
  bumpGitRefresh: () => void
  focusRun: (runId: string) => void
}

export const useStore = create<Store>((set, get) => ({
  config: { projects: [] },
  runs: [],
  activeRunId: null,
  activeProjectId: null,
  layout: 1,
  currentPage: 0,
  activeGitPath: null,
  gitRefreshTick: 0,

  load: async () => {
    const config = await getConfig()
    // 记住上次打开的项目;无效/无记录则默认第一个。
    const saved = localStorage.getItem(LAST_PROJECT_KEY)
    const valid = config.projects.find((p) => p.id === saved)
    const activeProjectId = valid ? saved : (config.projects[0]?.id ?? null)
    set({ config, activeProjectId, layout: loadLayout(activeProjectId), currentPage: 0 })
  },
  persist: async () => {
    await setConfig(get().config)
  },

  addProject: (name) => {
    const c = structuredClone(get().config)
    const id = uuid()
    c.projects.push({ id, name, directories: [], manualCommands: [] })
    const patch: Partial<Store> = { config: c }
    // 第一个项目自动设为当前项目
    if (!get().activeProjectId) {
      patch.activeProjectId = id
      localStorage.setItem(LAST_PROJECT_KEY, id)
    }
    set(patch)
    get().persist()
  },
  addDirectory: (pid, path) => {
    const c = structuredClone(get().config)
    c.projects.find((p) => p.id === pid)?.directories.push({ id: uuid(), path })
    set({ config: c })
    get().persist()
  },
  removeDirectory: (pid, dirId) => {
    const c = structuredClone(get().config)
    const p = c.projects.find((x) => x.id === pid)
    if (p) p.directories = p.directories.filter((d) => d.id !== dirId)
    set({ config: c })
    get().persist()
  },
  addManualCommand: (pid, label, cwd, command, origin) => {
    const c = structuredClone(get().config)
    const proj = c.projects.find((p) => p.id === pid)
    if (proj) {
      // 查重:对照项目里已有命令,仅当 标签+命令+目录 三者全同才视为重复并跳过
      // (防重复落地同一套提议;但命令+目录相同、标签不同的两条不同命令都保留,不误删)。
      const dup = proj.manualCommands.some(
        (m) => m.label === label && m.command === command && m.cwd === cwd,
      )
      if (!dup) {
        proj.manualCommands.push({ id: uuid(), label, cwd, command, long: true, ...(origin ? { origin } : {}) })
      }
    }
    set({ config: c })
    get().persist()
  },
  updateManualCommand: (pid, cmdId, label, cwd, command) => {
    const c = structuredClone(get().config)
    const m = c.projects.find((p) => p.id === pid)?.manualCommands.find((x) => x.id === cmdId)
    if (m) {
      m.label = label
      m.cwd = cwd
      m.command = command
    }
    set({ config: c })
    get().persist()
  },
  removeManualCommand: (pid, cmdId) => {
    const c = structuredClone(get().config)
    const p = c.projects.find((x) => x.id === pid)
    if (p) p.manualCommands = p.manualCommands.filter((m) => m.id !== cmdId)
    set({ config: c })
    get().persist()
  },
  removeProject: (id) => {
    const c = structuredClone(get().config)
    c.projects = c.projects.filter((p) => p.id !== id)
    let activeProjectId = get().activeProjectId
    if (activeProjectId === id) {
      activeProjectId = c.projects[0]?.id ?? null
      if (activeProjectId) localStorage.setItem(LAST_PROJECT_KEY, activeProjectId)
      else localStorage.removeItem(LAST_PROJECT_KEY)
    }
    set({ config: c, activeProjectId })
    get().persist()
  },
  setActiveProject: (id) => {
    localStorage.setItem(LAST_PROJECT_KEY, id)
    set({ activeProjectId: id, layout: loadLayout(id), currentPage: 0 })
  },
  // 切布局:写当前项目 localStorage;默认回第一页(用户偏好,不跟随聚焦格所在页)。
  setLayout: (n) =>
    set((s) => {
      if (s.activeProjectId) localStorage.setItem(LAYOUT_KEY(s.activeProjectId), String(n))
      return { layout: n, currentPage: 0 }
    }),
  setPage: (n) =>
    set((s) => {
      const vis = visibleRuns(s.runs, s.activeProjectId)
      return { currentPage: clampPage(n, vis.length, s.layout) }
    }),

  upsertRun: (r, focus) =>
    set((s) => {
      const projectId = r.projectId || inferProjectId(s.config, r.cwd)
      const run: RunState = { ...r, projectId }
      const runs = [...s.runs.filter((x) => x.runId !== r.runId), run]
      const patch: Partial<Store> = { runs, activeRunId: r.runId }
      // 用户主动启动时工作区切到该 run 的项目并读回其布局(reload 恢复不切,保留记忆项目)。
      let activeProjectId = s.activeProjectId
      let layout = s.layout
      if (focus && projectId) {
        activeProjectId = projectId
        layout = loadLayout(projectId)
        localStorage.setItem(LAST_PROJECT_KEY, projectId)
        patch.activeProjectId = projectId
        patch.layout = layout
      }
      // 聚焦格(=刚 upsert 的 run)落在哪一页 → currentPage。新 run 在 runs 末尾,自然是末页。
      const vis = visibleRuns(runs, activeProjectId)
      const idx = vis.findIndex((x) => x.runId === r.runId)
      patch.currentPage = clampPage(pageOf(idx, layout), vis.length, layout)
      return patch
    }),
  applyRunEvent: (runId, e) => {
    if (e.type === 'exit') {
      set((s) => ({
        runs: s.runs.map((r) =>
          r.runId === runId ? { ...r, status: 'exited', exitCode: e.code } : r,
        ),
      }))
    }
  },
  setActive: (runId) => set({ activeRunId: runId }),
  // 关闭并移除 tab;聚焦格被关则回退到当前页剩余 run(否则 visible 末个),页码钳制不越界。
  closeRun: (runId) =>
    set((s) => {
      const runs = s.runs.filter((r) => r.runId !== runId)
      const vis = visibleRuns(runs, s.activeProjectId)
      let activeRunId = s.activeRunId
      if (s.activeRunId === runId) {
        const start = s.currentPage * s.layout
        const pageRuns = vis.slice(start, start + s.layout)
        activeRunId = pageRuns[pageRuns.length - 1]?.runId ?? vis[vis.length - 1]?.runId ?? null
      }
      let currentPage = s.currentPage
      if (activeRunId) {
        const idx = vis.findIndex((r) => r.runId === activeRunId)
        currentPage = clampPage(pageOf(idx, s.layout), vis.length, s.layout)
      } else {
        currentPage = clampPage(currentPage, vis.length, s.layout)
      }
      return { runs, activeRunId, currentPage }
    }),
  openGit: (path) => set({ activeGitPath: path }),
  closeGit: () => set({ activeGitPath: null }),
  bumpGitRefresh: () => set((s) => ({ gitRefreshTick: s.gitRefreshTick + 1 })),
  // 查看某运行中的命令:关 git 面板 + 切到该 run 所在项目/页 + 聚焦(不再跑一个实例)。
  focusRun: (runId) =>
    set((s) => {
      const run = s.runs.find((r) => r.runId === runId)
      if (!run) return {}
      const activeProjectId = run.projectId || s.activeProjectId
      const layout = loadLayout(activeProjectId)
      const vis = visibleRuns(s.runs, activeProjectId)
      const idx = vis.findIndex((r) => r.runId === runId)
      const currentPage = clampPage(pageOf(idx, layout), vis.length, layout)
      if (activeProjectId) localStorage.setItem(LAST_PROJECT_KEY, activeProjectId)
      return { activeGitPath: null, activeRunId: runId, activeProjectId, layout, currentPage }
    }),
}))

// dev-only：暴露 store 便于浏览器内调试 / 视觉走查
if (import.meta.env.DEV) {
  ;(window as unknown as { __store?: typeof useStore }).__store = useStore
}
