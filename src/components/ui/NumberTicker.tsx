import { useEffect } from 'react'
import { useMotionValue, useSpring, useTransform, motion } from 'motion/react'

/// 数字滚动。MagicUI NumberTicker：spring 平滑过渡到目标值，整数显示。
export function NumberTicker({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value)
  const spring = useSpring(mv, { stiffness: 140, damping: 20 })
  const text = useTransform(spring, (v) => Math.round(v).toString())

  useEffect(() => {
    mv.set(value)
  }, [mv, value])

  return <motion.span className={className}>{text}</motion.span>
}
