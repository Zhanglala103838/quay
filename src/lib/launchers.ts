/// 外部编辑器 / 终端启动器注册表(SSoT)。
/// 设置面板、侧栏图标、启动 IPC 都从这里取数据,改一处即全联动。
///
/// macOS:经 LaunchServices 按 bundle id 启动(`open -b <bid> <dir>`),用 mdfind 探测已装。
/// Windows:无 bundle id 概念,改用 PATH 命令探测(`where <probe>`)+ 经 `cmd /c` 启动
///   (cli 多为 .cmd 垫片,CreateProcess 不能直接执行,必须走 cmd;`{dir}` 占位由后端替换)。
/// 两套数据并存于同一 def,前端按平台挑用(见 probeIds / launchArgs)。

export interface LauncherDef {
  /** 内部稳定 key(存进设置 / 派 EditorIcon) */
  key: string
  /** 面板与提示展示名 */
  label: string
  /** macOS:按优先级尝试的 bundle id(命中第一个即启动;留多个兼容不同发行版) */
  bundleIds: string[]
  /** Windows:PATH 探测名 + 启动 argv(argv[0]=程序,元素含字面量 "{dir}" 由后端替换为目录) */
  win?: { probe: string[]; argv: string[] }
}

/** 当前是否 Windows(WebView2 的 UA 含 "Windows";mac WKWebView 含 "Macintosh")。 */
export const IS_WINDOWS =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

/// 常用编辑器。图标见 components/AppIcons.tsx 的 EditorIcon(按 key 分派品牌字形)。
/// Windows 经各自 CLI 垫片打开目录(code/cursor/... "<dir>");Xcode 仅 macOS。
export const EDITORS: LauncherDef[] = [
  { key: 'vscode', label: 'VS Code', bundleIds: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'], win: { probe: ['code'], argv: ['cmd', '/c', 'code', '{dir}'] } },
  { key: 'cursor', label: 'Cursor', bundleIds: ['com.todesktop.230313mzl4w4u92'], win: { probe: ['cursor'], argv: ['cmd', '/c', 'cursor', '{dir}'] } },
  { key: 'windsurf', label: 'Windsurf', bundleIds: ['com.exafunction.windsurf'], win: { probe: ['windsurf'], argv: ['cmd', '/c', 'windsurf', '{dir}'] } },
  { key: 'zed', label: 'Zed', bundleIds: ['dev.zed.Zed'], win: { probe: ['zed'], argv: ['cmd', '/c', 'zed', '{dir}'] } },
  { key: 'sublime', label: 'Sublime Text', bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'], win: { probe: ['subl'], argv: ['cmd', '/c', 'subl', '{dir}'] } },
  { key: 'xcode', label: 'Xcode', bundleIds: ['com.apple.dt.Xcode'] },
]

/// 外置终端。前段为 macOS(Terminal/Ghostty/cmux/iTerm2/Warp),后段为 Windows
/// (Windows Terminal / PowerShell / cmd —— 经 `start` 在新窗口打开并切到该目录)。
export const TERMINALS: LauncherDef[] = [
  { key: 'terminal', label: 'Terminal', bundleIds: ['com.apple.Terminal'] },
  { key: 'ghostty', label: 'Ghostty', bundleIds: ['com.mitchellh.ghostty'] },
  { key: 'cmux', label: 'cmux', bundleIds: ['com.cmuxterm.app'] },
  { key: 'iterm2', label: 'iTerm2', bundleIds: ['com.googlecode.iterm2'] },
  { key: 'warp', label: 'Warp', bundleIds: ['dev.warp.Warp-Stable'] },
  // ── Windows ──(start "" 让新终端独立成窗;wt 用 -d,powershell/cmd 用 start /D 切目录)
  { key: 'wt', label: 'Windows Terminal', bundleIds: [], win: { probe: ['wt'], argv: ['cmd', '/c', 'start', '', 'wt', '-d', '{dir}'] } },
  { key: 'powershell', label: 'PowerShell', bundleIds: [], win: { probe: ['powershell'], argv: ['cmd', '/c', 'start', '', '/D', '{dir}', 'powershell'] } },
  { key: 'cmd', label: 'Command Prompt', bundleIds: [], win: { probe: ['cmd'], argv: ['cmd', '/c', 'start', '', '/D', '{dir}', 'cmd'] } },
]

/** 该 def 在当前平台是否可用(有对应平台的数据)。 */
const supported = (d: LauncherDef): boolean => (IS_WINDOWS ? !!d.win : d.bundleIds.length > 0)

/** 当前平台应展示/可选的编辑器与终端(过滤掉无本平台支持的)。 */
export const editorsForPlatform = (): LauncherDef[] => EDITORS.filter(supported)
export const terminalsForPlatform = (): LauncherDef[] => TERMINALS.filter(supported)

/** 探测用标识:Windows=PATH 探测名,macOS=bundle id。喂给 detectApps。 */
export const probeIds = (def: LauncherDef): string[] =>
  IS_WINDOWS ? (def.win?.probe ?? []) : def.bundleIds

/** 启动用参数:Windows=argv(含 {dir} 占位),macOS=bundle id 列表。喂给 openWithApp。 */
export const launchArgs = (def: LauncherDef): string[] =>
  IS_WINDOWS ? (def.win?.argv ?? []) : def.bundleIds

export const editorByKey = (key: string): LauncherDef => {
  const list = editorsForPlatform()
  return EDITORS.find((e) => e.key === key && supported(e)) ?? list[0] ?? EDITORS[0]
}

export const terminalByKey = (key: string): LauncherDef => {
  const list = terminalsForPlatform()
  return TERMINALS.find((t) => t.key === key && supported(t)) ?? list[0] ?? TERMINALS[0]
}

/// 某启动器是否已安装:其任一本平台探测标识命中扫描结果即视为已装。
export const isInstalled = (def: LauncherDef, installed: ReadonlySet<string>): boolean =>
  probeIds(def).some((b) => installed.has(b))
