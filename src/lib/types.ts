export interface Command { name: string; command: string; source: string; category: string }
export interface Directory { id: string; path: string }
export interface CommandEntry {
  id: string
  label: string
  cwd: string
  command: string
  long?: boolean
  confirmBeforeRun?: boolean
  origin?: 'ai'
}
/// 聚合命令组成员:用「快照」自包含(label/cwd/command),不引用源命令。
/// 扫描命令无稳定 id(rename/删 script 即丢),手动命令也可能被删,引用会悬空。
export interface GroupMember { label: string; cwd: string; command: string }
/// 聚合命令组:挑几条命令打包,一键并行各开各的 tab。
export interface CommandGroup { id: string; name: string; members: GroupMember[] }
export interface Project {
  id: string
  name: string
  directories: Directory[]
  manualCommands: CommandEntry[]
  commandGroups: CommandGroup[]
}
export interface Config { projects: Project[] }
export interface ScanResult { commands: Command[]; dirExists: boolean; detectedSources: string[] }
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
export interface MemStat { runId: string; memBytes: number; ports: number[] }
export interface MemReport { appBytes: number; runs: MemStat[] }

/// 某绑定目录声明的 Tauri dev 端口(tauri.conf devUrl)。用于"不同项目同端口"体检。
export interface DevPort { projectId: string; projectName: string; path: string; port: number }
/// 端口被谁占了(lsof 实测)。启动前探测,防 Tauri 窗口加载到错的应用。
export interface PortBusy { port: number; pid: number; process: string }

/// 后端仍在跑(或最近退出)的 run,用于前端 reload 后恢复。
export interface RunInfo {
  runId: string
  label: string
  cwd: string
  command: string
  status: 'running' | 'exited'
  exitCode: number | null
  interactive: boolean
}

/// git 状态(字段对齐 Rust 的 serde rename_all="camelCase")。
export interface GitBrief {
  isRepo: boolean
  branch: string
  headShort: string
  detached: boolean
  dirty: number
  ahead: number
  behind: number
  hasUpstream: boolean
}
export interface GitFile {
  status: string
  path: string
  /// 行数 sentinel：>=0 实际；-1 二进制；-2 未跟踪。
  added: number
  deleted: number
}
export interface GitRef {
  name: string
  kind: 'head' | 'local' | 'remote' | 'tag'
}
export interface GitCommit {
  hash: string
  subject: string
  author: string
  relTime: string
  parents: string[]
  refs: GitRef[]
  unpushed: boolean
}
export interface GitBranch {
  name: string
  current: boolean
  upstream: string
}
export interface GitDetail {
  isRepo: boolean
  repoRoot: string
  branch: string
  headShort: string
  detached: boolean
  ahead: number
  behind: number
  hasUpstream: boolean
  files: GitFile[]
  commits: GitCommit[]
  branches: GitBranch[]
  viewing: string
}

export interface ContextFile { relPath: string; content: string; truncated: boolean }
export interface ProjectContext {
  root: string
  tree: string[]
  files: ContextFile[]
  detectedSources: string[]
}
export interface Proposal { name: string; command: string; cwd: string; why: string }
