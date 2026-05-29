import { create } from 'zustand'

export interface ConfirmReq {
  title: string
  message?: string
  confirmText?: string
  onConfirm: () => void
}

interface ConfirmStore {
  pending: ConfirmReq | null
  ask: (r: ConfirmReq) => void
  close: () => void
}

export const useConfirm = create<ConfirmStore>((set) => ({
  pending: null,
  ask: (r) => set({ pending: r }),
  close: () => set({ pending: null }),
}))

/// 命令式调用:askConfirm({ title, message, onConfirm })。
/// 必须用应用内弹窗 —— window.confirm 在 Tauri WKWebView 不工作。
export const askConfirm = (r: ConfirmReq) => useConfirm.getState().ask(r)
