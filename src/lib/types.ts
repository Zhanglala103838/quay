export interface Script { name: string; command: string }
export interface Directory { id: string; path: string }
export interface CommandEntry {
  id: string
  label: string
  cwd: string
  command: string
  long?: boolean
  confirmBeforeRun?: boolean
}
export interface Project {
  id: string
  name: string
  directories: Directory[]
  manualCommands: CommandEntry[]
}
export interface Config { projects: Project[] }
export interface ScanResult { scripts: Script[]; dirExists: boolean; hasPackageJson: boolean }
export interface Orphan {
  runId: string
  pid: number
  pgid: number
  command: string
  cwd: string
  label: string
}
export type RunEvent =
  | { type: 'output'; chunk: string }
  | { type: 'exit'; code: number | null }

/// 内存采集:app 主进程 RSS(偏小,不含 webview helper) + 每条 running 命令的进程组树 RSS。
export interface MemStat { runId: string; memBytes: number }
export interface MemReport { appBytes: number; runs: MemStat[] }

/// 后端仍在跑(或最近退出)的 run,用于前端 reload 后恢复。
export interface RunInfo {
  runId: string
  label: string
  cwd: string
  command: string
  status: 'running' | 'exited'
  exitCode: number | null
}
