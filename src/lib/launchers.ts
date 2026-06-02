/// 外部编辑器 / 终端启动器注册表(SSoT)。
/// 设置面板、侧栏图标、启动 IPC 都从这里取数据,改一处即全联动。
/// macOS 经 LaunchServices 按 bundle id 启动:`open -b <bid> <dir>`。
/// 编辑器把目录当 workspace 打开;终端三者(Terminal/Ghostty/cmux/...)都声明了
/// Folder/directory 文档类型,故同一句 open -b 即在该目录开一个会话。

export interface LauncherDef {
  /** 内部稳定 key(存进设置 / 派 EditorIcon) */
  key: string
  /** 面板与提示展示名 */
  label: string
  /** 按优先级尝试的 bundle id(命中第一个即启动;留多个兼容不同发行版) */
  bundleIds: string[]
}

/// 常用编辑器。图标见 components/AppIcons.tsx 的 EditorIcon(按 key 分派品牌字形)。
export const EDITORS: LauncherDef[] = [
  { key: 'vscode', label: 'VS Code', bundleIds: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'] },
  { key: 'cursor', label: 'Cursor', bundleIds: ['com.todesktop.230313mzl4w4u92'] },
  { key: 'windsurf', label: 'Windsurf', bundleIds: ['com.exafunction.windsurf'] },
  { key: 'zed', label: 'Zed', bundleIds: ['dev.zed.Zed'] },
  { key: 'sublime', label: 'Sublime Text', bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'] },
  { key: 'xcode', label: 'Xcode', bundleIds: ['com.apple.dt.Xcode'] },
]

/// 外置终端。前三项为明确支持(Terminal/Ghostty/cmux),后两项为常见可扫描项。
export const TERMINALS: LauncherDef[] = [
  { key: 'terminal', label: 'Terminal', bundleIds: ['com.apple.Terminal'] },
  { key: 'ghostty', label: 'Ghostty', bundleIds: ['com.mitchellh.ghostty'] },
  { key: 'cmux', label: 'cmux', bundleIds: ['com.cmuxterm.app'] },
  { key: 'iterm2', label: 'iTerm2', bundleIds: ['com.googlecode.iterm2'] },
  { key: 'warp', label: 'Warp', bundleIds: ['dev.warp.Warp-Stable'] },
]

export const editorByKey = (key: string): LauncherDef =>
  EDITORS.find((e) => e.key === key) ?? EDITORS[0]

export const terminalByKey = (key: string): LauncherDef =>
  TERMINALS.find((t) => t.key === key) ?? TERMINALS[0]

/// 某启动器是否已安装:其任一 bundle id 命中扫描结果即视为已装。
export const isInstalled = (def: LauncherDef, installed: ReadonlySet<string>): boolean =>
  def.bundleIds.some((b) => installed.has(b))
