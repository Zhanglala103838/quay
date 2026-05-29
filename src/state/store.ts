import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { Config, RunEvent } from '../lib/types'
import { getConfig, setConfig } from '../lib/ipc'

export interface RunState {
  runId: string
  label: string
  cwd: string
  command: string
  status: 'running' | 'exited'
  exitCode: number | null
}

interface Store {
  config: Config
  runs: RunState[]
  activeRunId: string | null
  load: () => Promise<void>
  persist: () => Promise<void>
  addProject: (name: string) => void
  addDirectory: (projectId: string, path: string) => void
  addManualCommand: (projectId: string, label: string, cwd: string, command: string) => void
  removeProject: (id: string) => void
  upsertRun: (r: RunState) => void
  applyRunEvent: (runId: string, e: RunEvent) => void
  setActive: (runId: string | null) => void
}

export const useStore = create<Store>((set, get) => ({
  config: { projects: [] },
  runs: [],
  activeRunId: null,

  load: async () => set({ config: await getConfig() }),
  persist: async () => {
    await setConfig(get().config)
  },

  addProject: (name) => {
    const c = structuredClone(get().config)
    c.projects.push({ id: uuid(), name, directories: [], manualCommands: [] })
    set({ config: c })
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
    set({ config: c })
    get().persist()
  },

  upsertRun: (r) =>
    set((s) => ({
      runs: [...s.runs.filter((x) => x.runId !== r.runId), r],
      activeRunId: r.runId,
    })),
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
