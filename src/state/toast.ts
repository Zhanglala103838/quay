import { create } from 'zustand'

interface ToastStore {
  msg: string | null
  /// 每次弹出自增,组件据此重置自动消失计时(连续弹同一文案也能续命)。
  seq: number
  show: (msg: string) => void
  clear: () => void
}

export const useToast = create<ToastStore>((set) => ({
  msg: null,
  seq: 0,
  show: (msg) => set((s) => ({ msg, seq: s.seq + 1 })),
  clear: () => set({ msg: null }),
}))

/// 命令式调用:showToast('未检测到 VSCode')。轻量浮层,~2s 自动消失。
export const showToast = (msg: string) => useToast.getState().show(msg)
