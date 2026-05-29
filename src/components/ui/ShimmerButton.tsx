import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/// 流光玻璃按钮。悬停时一道高光横扫，玻璃底 + 青色光晕。
export function ShimmerButton({
  children,
  className,
  ...props
}: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn('shimmer-btn', className)} {...props}>
      <span className="shimmer-sweep" aria-hidden />
      <span className="shimmer-label">{children}</span>
    </button>
  )
}
