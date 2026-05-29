import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

/// 命令在后台跑完时发原生通知。仅在窗口失焦时打扰——前台时 RunningBar/终端已可见,无需通知。
/// 权限只探一次并缓存,首次需要时才向系统申请。

let granted: boolean | null = null

async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted
  granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === 'granted'
  return granted
}

export async function notifyCommandDone(label: string, code: number | null): Promise<void> {
  if (document.hasFocus()) return // 前台不打扰
  if (!(await ensurePermission())) return
  const ok = code === 0
  sendNotification({
    title: ok ? `✓ ${label}` : `✗ ${label}`,
    body: ok ? '命令已完成' : `命令已结束（退出码 ${code ?? '?'}）`,
  })
}
