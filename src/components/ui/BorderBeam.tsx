import { cn } from '../../lib/cn'

/// 旋转流光描边。用 @property --beam-angle 驱动 conic-gradient 旋转，
/// 配 mask 只露出 1px 边框。比 motion offset-path 版更轻、不丢帧。
export function BorderBeam({
  className,
  duration = 6,
  size = 1.5,
  color = 'var(--accent)',
}: {
  className?: string
  duration?: number
  size?: number
  color?: string
}) {
  return (
    <span
      className={cn('border-beam', className)}
      style={
        {
          '--beam-duration': `${duration}s`,
          '--beam-size': `${size}px`,
          '--beam-color': color,
        } as React.CSSProperties
      }
    />
  )
}
