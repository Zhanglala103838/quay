import { useStore } from '../state/store'

export function RunningBar() {
  const running = useStore((s) => s.runs.filter((r) => r.status === 'running'))
  return (
    <div className="runningbar">
      <span className={'pulse' + (running.length ? ' on' : '')} />
      全局 {running.length} 个在跑
      {running.length > 0 && <span className="running-list"> · {running.map((r) => r.label).join('   ')}</span>}
    </div>
  )
}
