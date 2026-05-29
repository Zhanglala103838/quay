/// 顶栏左侧:折叠/展开侧栏项目树。放标题栏(而非侧栏内)以保证折叠后仍可点回。
/// 图标 = lucide panel-left,样式复刻 .gear-btn(玻璃描边 + accent hover)。
export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="panel-btn"
      aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
      title={collapsed ? '展开侧栏' : '折叠侧栏'}
      onClick={onToggle}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 3v18" />
      </svg>
    </button>
  )
}
