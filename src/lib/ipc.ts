import { invoke, Channel } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Config, ScanResult, Orphan, RunEvent, RunInfo, MemReport, GitBrief, GitDetail } from './types'

/// 拉起原生目录选择器,返回选中的绝对路径;取消返回 null。
export async function pickDirectory(): Promise<string | null> {
  const res = await open({ directory: true, multiple: false })
  return typeof res === 'string' ? res : null
}

export const scanDir = (path: string) => invoke<ScanResult>('scan_dir', { path })
/// 开始监听该目录 package.json,变更时后端 emit `pkg-changed`(payload { path })。与 unwatchDir 配对。
export const watchDir = (path: string) => invoke<void>('watch_dir', { path })
export const unwatchDir = (path: string) => invoke<void>('unwatch_dir', { path })
export const getConfig = () => invoke<Config>('get_config')
export const setConfig = (cfg: Config) => invoke<void>('set_config', { cfg })
export const stopCommand = (runId: string) => invoke<void>('stop_command', { runId })
export const closeCommand = (runId: string) => invoke<void>('close_command', { runId })
/// fit 出真实列/行后同步 PTY 尺寸,让生产者按显示宽度重排新输出(发 SIGWINCH)。
export const resizeRun = (runId: string, cols: number, rows: number) =>
  invoke<void>('resize_run', { runId, cols, rows })
export const replay = (runId: string) => invoke<string>('replay', { runId })
/// 打开 WebView 开发者工具(右键菜单「检查元素」)。需后端 devtools 能力(debug 天然有 / release 开 feature)。
export const openDevtools = () => invoke<void>('open_devtools')
export const listRuns = () => invoke<RunInfo[]>('list_runs')
export const runsMemory = () => invoke<MemReport>('runs_memory')
export const listOrphans = () => invoke<Orphan[]>('list_orphans')
export const killOrphan = (pgid: number) => invoke<void>('kill_orphan', { pgid })
export const gitBrief = (path: string) => invoke<GitBrief>('git_brief', { path })
export const gitDetail = (path: string, rev?: string) =>
  invoke<GitDetail>('git_detail', { path, rev: rev ?? '' })

export function runCommand(
  args: { runId: string; label: string; cwd: string; command: string; interactive?: boolean },
  onEvent: (e: RunEvent) => void,
): Promise<number> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<number>('run_command', { interactive: false, ...args, onEvent: ch })
}

/// 把键盘输入写进交互终端的 PTY stdin(只读 run 调用无副作用)。
export const writeRun = (runId: string, data: string) =>
  invoke<void>('write_run', { runId, data })

/// 用 VSCode 打开目录;未装 VSCode 时 reject("未检测到 VSCode")。
export const openInVscode = (path: string) => invoke<void>('open_in_vscode', { path })

/// 前端 reload 后给已有 run 重新挂 Channel(后端会回放历史 + 续接实时)。
export function attachRun(runId: string, onEvent: (e: RunEvent) => void): Promise<void> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<void>('attach_run', { runId, onEvent: ch })
}
