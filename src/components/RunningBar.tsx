import { useStore } from '../state/store'
import { NumberTicker } from './ui/NumberTicker'

export function RunningBar() {
  // selector 必须返回稳定引用,否则 zustand v5 会判定每次都变 → 无限重渲染。
  // 取 s.runs(引用稳定),在组件体内 filter。
  const runs = useStore((s) => s.runs)
  const running = runs.filter((r) => r.status === 'running')
  return (
    <div className="runningbar">
      <span className={'pulse' + (running.length ? ' on' : '')} />
      <span className="running-label">全局</span>
      <NumberTicker className="running-count" value={running.length} />
      <span className="running-label">个在跑</span>
      {running.length > 0 && (
        <span className="running-list">
          {running.map((r) => (
            <span key={r.runId} className="running-chip">
              {r.label}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}
