import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { Config, RunEvent } from '../lib/types'
import { getConfig, setConfig } from '../lib/ipc'

const LAST_PROJECT_KEY = 'quay.activeProjectId'

export interface RunState {
  runId: string
  label: string
  cwd: string
  command: string
  status: 'running' | 'exited'
  exitCode: number | null
  projectId: string // 归属项目(由 cwd 推断);'' = 未归属
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
  load: () => Promise<void>
  persist: () => Promise<void>
  addProject: (name: string) => void
  addDirectory: (projectId: string, path: string) => void
  addManualCommand: (projectId: string, label: string, cwd: string, command: string) => void
  removeProject: (id: string) => void
  setActiveProject: (id: string) => void
  upsertRun: (r: Omit<RunState, 'projectId'> & { projectId?: string }, focus?: boolean) => void
  applyRunEvent: (runId: string, e: RunEvent) => void
  setActive: (runId: string | null) => void
}

export const useStore = create<Store>((set, get) => ({
  config: { projects: [] },
  runs: [],
  activeRunId: null,
  activeProjectId: null,

  load: async () => {
    const config = await getConfig()
    // 记住上次打开的项目;无效/无记录则默认第一个。
    const saved = localStorage.getItem(LAST_PROJECT_KEY)
    const valid = config.projects.find((p) => p.id === saved)
    const activeProjectId = valid ? saved : (config.projects[0]?.id ?? null)
    set({ config, activeProjectId })
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
  addManualCommand: (pid, label, cwd, command) => {
    const c = structuredClone(get().config)
    c.projects
      .find((p) => p.id === pid)
      ?.manualCommands.push({ id: uuid(), label, cwd, command, long: true })
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
    set({ activeProjectId: id })
  },

  upsertRun: (r, focus) =>
    set((s) => {
      const projectId = r.projectId || inferProjectId(s.config, r.cwd)
      const run: RunState = { ...r, projectId }
      const patch: Partial<Store> = {
        runs: [...s.runs.filter((x) => x.runId !== r.runId), run],
        activeRunId: r.runId,
      }
      // 用户主动启动时,工作区切到该 run 的项目(reload 恢复不切,以免覆盖记忆的项目)
      if (focus && projectId) {
        patch.activeProjectId = projectId
        localStorage.setItem(LAST_PROJECT_KEY, projectId)
      }
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
}))

// dev-only：暴露 store 便于浏览器内调试 / 视觉走查
if (import.meta.env.DEV) {
  ;(window as unknown as { __store?: typeof useStore }).__store = useStore
}
