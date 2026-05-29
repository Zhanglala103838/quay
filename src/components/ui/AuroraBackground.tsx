/// 子夜港湾氛围背景：极光渐变 mesh + 网点栅格 + 颗粒噪点。
/// 纯 CSS 动画，固定铺底，不拦截指针事件。MagicUI Aurora 思路的轻量自研版。
export function AuroraBackground() {
  return (
    <div className="aurora-root" aria-hidden>
      <div className="aurora-blob aurora-blob-1" />
      <div className="aurora-blob aurora-blob-2" />
      <div className="aurora-blob aurora-blob-3" />
      <div className="aurora-grid" />
      <div className="aurora-grain" />
      <div className="aurora-vignette" />
    </div>
  )
}
