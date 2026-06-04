/// 项目头部「新增」操作图标(hover 才浮现)。stroke 单色 currentColor,与 TerminalIcon 同风格。
/// 三个都带 + 号motif 表「新增」;字形彼此区分、且不与 📁(目录节点)/终端 icon/品牌 logo 撞。

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/// 新增目录:folder-plus(文件夹 + 加号)。
export function FolderPlusIcon() {
  return (
    <Svg>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M9 13h6" />
      <path d="M12 10v6" />
    </Svg>
  )
}

/// 新增命令:list-plus(列表行 + 加号),表"往命令列表里加一条"。
export function CommandPlusIcon() {
  return (
    <Svg>
      <path d="M11 12H3" />
      <path d="M16 6H3" />
      <path d="M16 18H3" />
      <path d="M18 9v6" />
      <path d="M21 12h-6" />
    </Svg>
  )
}

/// 新建命令组:copy-plus(两层叠放方块 + 加号),表"把多条命令聚成一组"。
export function GroupPlusIcon() {
  return (
    <Svg>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      <path d="M15 11v6" />
      <path d="M12 14h6" />
    </Svg>
  )
}

/// 重命名:pencil(铅笔),与 GroupRow 的 ✎ 同语义,统一为线性字形。
export function RenameIcon() {
  return (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  )
}

/// 复制路径:clipboard-copy(两层方块,无加号,区别于 GroupPlus 的"+")。
export function CopyPathIcon() {
  return (
    <Svg>
      <rect width="13" height="13" x="9" y="9" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  )
}

/// 在文件管理器打开:folder-open(打开的文件夹),区别于 FolderPlus(带 +)。
export function FolderOpenIcon() {
  return (
    <Svg>
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H21a1 1 0 0 1 .96 1.27l-1.43 5A2 2 0 0 1 18.6 18H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.69.9H18a2 2 0 0 1 2 2v1" />
    </Svg>
  )
}
