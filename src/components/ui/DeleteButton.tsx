/// 统一的删除按钮。所有"删除/移除"入口都用它,样式集中在 .delete-btn 一处。
/// floatRight:在一行内把按钮推到最右(目录行/命令行用)。
export function DeleteButton({
  onClick,
  title = '删除',
  floatRight = false,
}: {
  onClick: () => void
  title?: string
  floatRight?: boolean
}) {
  return (
    <button
      type="button"
      className={'delete-btn' + (floatRight ? ' delete-btn-right' : '')}
      aria-label={title}
      // 靠右是布局需求,用内联保证(主题/配色交给 .delete-btn 由视觉会话统一)
      style={floatRight ? { marginLeft: 'auto' } : undefined}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      ✕
    </button>
  )
}
