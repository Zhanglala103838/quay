import { invoke, Channel } from '@tauri-apps/api/core'
import type { Config, ScanResult, Orphan, RunEvent } from './types'

export const scanDir = (path: string) => invoke<ScanResult>('scan_dir', { path })
export const getConfig = () => invoke<Config>('get_config')
export const setConfig = (cfg: Config) => invoke<void>('set_config', { cfg })
export const stopCommand = (runId: string) => invoke<void>('stop_command', { runId })
export const replay = (runId: string) => invoke<string>('replay', { runId })
export const listOrphans = () => invoke<Orphan[]>('list_orphans')
export const killOrphan = (pgid: number) => invoke<void>('kill_orphan', { pgid })

export function runCommand(
  args: { runId: string; label: string; cwd: string; command: string },
  onEvent: (e: RunEvent) => void,
): Promise<number> {
  const ch = new Channel<RunEvent>()
  ch.onmessage = onEvent
  return invoke<number>('run_command', { ...args, onEvent: ch })
}
