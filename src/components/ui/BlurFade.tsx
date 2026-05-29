import type { ReactNode } from 'react'
import { motion } from 'motion/react'

/// 模糊上浮入场。MagicUI BlurFade 思路：opacity + blur + y 位移，支持 stagger delay。
export function BlurFade({
  children,
  delay = 0,
  y = 8,
  className,
}: {
  children: ReactNode
  delay?: number
  y?: number
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, filter: 'blur(8px)', y }}
      animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
