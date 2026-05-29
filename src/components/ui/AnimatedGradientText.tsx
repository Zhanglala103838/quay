import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

/// 渐变流光文字（logo / 标题）。background-clip:text + 背景平移动画。
export function AnimatedGradientText({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={cn('gradient-text', className)}>{children}</span>
}
