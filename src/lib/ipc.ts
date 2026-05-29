import { invoke, Channel } from '@tauri-apps/api/core'
import type { Config, ScanResult, Orphan, RunEvent, RunInfo, MemReport } from './types'

export const scanDir = (path: string) => invoke<ScanResult>('scan_dir', { path })
export const getConfig = () => invoke<Config>('get_config')
export const setConfig = (cfg: Config) => invoke<void>('set_config', { cfg })
export const stopCommand = (runId: string) => invoke<void>('stop_command', { runId })
export const closeCommand = (runId: string) => invoke<void>('close_command', { runId })
/// fit 出真实列/行后同步 PTY 尺寸,让生产者按显示宽度重排新输出(发 SIGWINCH)。
export const resizeRun = (runId: string, cols: number, rows: number) =>
  invoke<void>('resize_run', { runId, cols, rows })
export const replay = (runId: string) => invoke<string>('replay', { runId })
export const listRuns = () => invoke<RunInfo[]>('list_runs')
export const runsMemory = () => invoke<MemReport>('runs_memory')
export const listOrphans = () => invoke<Orphan[]>('list_orphans')
export const killOrphan = (pgid: number) => invoke<void>('kill_orphan', { pgid })

export function runCommand(
  args: { runId: string; label: string; cwd: string; command: string },
  onEvent: (e: RunEvent) => void,
): Promise<number> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<number>('run_command', { ...args, onEvent: ch })
}

/// 前端 reload 后给已有 run 重新挂 Channel(后端会回放历史 + 续接实时)。
export function attachRun(runId: string, onEvent: (e: RunEvent) => void): Promise<void> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<void>('attach_run', { runId, onEvent: ch })
}
