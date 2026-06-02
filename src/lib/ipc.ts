import { invoke, Channel } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Config, ScanResult, Orphan, RunEvent, RunInfo, MemReport, GitBrief, GitDetail, ProjectContext, DevPort, PortBusy } from './types'

/// 拉起原生目录选择器,返回选中的绝对路径;取消返回 null。
export async function pickDirectory(): Promise<string | null> {
  const res = await open({ directory: true, multiple: false })
  return typeof res === 'string' ? res : null
}

export const scanDir = (path: string) => invoke<ScanResult>('scan_dir', { path })
/// L2：采集项目上下文(浅递归 + 白名单关键文件)，供前端喂给 DeepSeek 提议命令。
export const collectContext = (path: string) => invoke<ProjectContext>('collect_context', { path })
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
/// 各绑定目录声明的 Tauri dev 端口(静态体检"不同项目同端口")。
export const devPorts = () => invoke<DevPort[]>('dev_ports')
/// 启动前探测:该 cwd 的 Tauri dev 端口此刻是否已被占用(null=空闲/未声明)。
export const devPortBusy = (cwd: string) => invoke<PortBusy | null>('dev_port_busy', { cwd })
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

/// 经 LaunchServices 用某 app 打开目录(编辑器当 workspace / 终端在该目录开会话)。
/// 按 bundleIds 顺序尝试,命中第一个即成功;一个都没装则 reject(前端据此弹「未检测到 X」)。
export const openWithApp = (path: string, bundleIds: string[]) =>
  invoke<void>('open_with_app', { path, bundleIds })

/// 扫描给定 bundle id 哪些已安装(走 LaunchServices,不依赖 Spotlight)。返回已装子集。
export const detectApps = (bundleIds: string[]) =>
  invoke<string[]>('detect_apps', { bundleIds })

/// 前端 reload 后给已有 run 重新挂 Channel(后端会回放历史 + 续接实时)。
export function attachRun(runId: string, onEvent: (e: RunEvent) => void): Promise<void> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<void>('attach_run', { runId, onEvent: ch })
}
