import { useStore } from '../state/store'

export function RunningBar() {
  // selector 必须返回稳定引用,否则 zustand v5 会判定每次都变 → 无限重渲染。
  // 取 s.runs(引用稳定),在组件体内 filter。
  const runs = useStore((s) => s.runs)
  const running = runs.filter((r) => r.status === 'running')
  return (
    <div className="runningbar">
      <span className={'pulse' + (running.length ? ' on' : '')} />
      全局 {running.length} 个在跑
      {running.length > 0 && <span className="running-list"> · {running.map((r) => r.label).join('   ')}</span>}
    </div>
  )
}
