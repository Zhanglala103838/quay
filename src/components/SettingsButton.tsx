import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Tooltip } from '@heroui/react'
import { useSettings } from '../state/settings'
import { SettingsModal } from './SettingsModal'

/// 顶栏右上角设置入口：齿轮 + 已配置绿点；自管开关状态。
/// 也响应原生菜单「设置… ⌘,」(后端 emit menu-open-settings)。
export function SettingsButton() {
  const configured = useSettings((s) => s.configured)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const un = listen('menu-open-settings', () => setOpen(true))
    return () => {
      un.then((u) => u())
    }
  }, [])

  return (
    <>
      <Tooltip>
        <Tooltip.Trigger>
          <button className="gear-btn" aria-label="设置" onClick={() => setOpen(true)}>
            <span className="gear-icon">⚙</span>
            {configured && <span className="gear-dot" />}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Content>{configured ? 'DeepSeek 已配置 · 设置' : '设置 DeepSeek'}</Tooltip.Content>
      </Tooltip>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  )
}
