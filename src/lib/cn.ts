import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 className，处理 Tailwind 冲突。MagicUI / shadcn 生态约定的 cn。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
