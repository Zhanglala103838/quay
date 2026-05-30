import { useMemo } from 'react'
import type { GitCommit, GitRef } from '../lib/types'
import { computeGraph } from '../lib/gitGraph'

const LANE_W = 15
const ROW_H = 36
const NODE_R = 4.5

// lane 调色板:取自 aurora token(cyan/teal/indigo/amber/coral/violet),按列循环。
const LANE_COLORS = ['#38e8ff', '#34e8a4', '#6366f1', '#fbbf24', '#ff6b6b', '#a78bfa']
const laneColor = (col: number) => LANE_COLORS[col % LANE_COLORS.length]

const x = (lane: number) => lane * LANE_W + LANE_W / 2
const y = (row: number) => row * ROW_H + ROW_H / 2

function refClass(kind: GitRef['kind']) {
  return `gg-ref gg-ref-${kind}`
}

/// 真·拓扑树:SVG 连线(贝塞尔) + 节点 + 右侧 ref 徽标 / 未推 / 标题 / 时间。
export function GitGraph({ commits }: { commits: GitCommit[] }) {
  const { rows, width } = useMemo(() => computeGraph(commits), [commits])
  if (rows.length === 0) return <div className="git-clean-hint">还没有提交</div>

  const gutterW = width * LANE_W
  const svgH = rows.length * ROW_H

  return (
    <div className="git-graph">
      <svg className="git-graph-lanes" width={gutterW} height={svgH} aria-hidden>
        {/* 连线:先画(在节点下层) */}
        {rows.map((r, i) =>
          r.edges.map((e, k) => {
            const x1 = x(e.from)
            const y1 = y(i)
            const x2 = x(e.to)
            const y2 = y(i + 1)
            const c = laneColor(e.to)
            if (e.from === e.to) {
              return <line key={`${i}-${k}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={1.5} />
            }
            const ym = (y1 + y2) / 2
            return (
              <path
                key={`${i}-${k}`}
                d={`M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`}
                fill="none"
                stroke={c}
                strokeWidth={1.5}
              />
            )
          }),
        )}
        {/* 节点 */}
        {rows.map((r, i) => {
          const isHead = r.commit.refs.some((rf) => rf.kind === 'head')
          return (
            <circle
              key={r.commit.hash}
              cx={x(r.col)}
              cy={y(i)}
              r={isHead ? NODE_R + 1 : NODE_R}
              fill={isHead ? laneColor(r.col) : '#0a1018'}
              stroke={laneColor(r.col)}
              strokeWidth={1.8}
            />
          )
        })}
      </svg>

      <div className="git-graph-rows">
        {rows.map((r) => {
          const c = r.commit
          return (
            <div className="git-graph-row" key={c.hash} style={{ height: ROW_H }}>
              <span className="gg-hash">{c.hash}</span>
              {c.refs.map((rf) => (
                <span className={refClass(rf.kind)} key={rf.kind + rf.name} title={rf.name}>
                  {rf.kind === 'tag' ? `⌑ ${rf.name}` : rf.name}
                </span>
              ))}
              <span className="gg-subject">{c.subject}</span>
              {c.unpushed && <span className="gg-unpushed">⇡ 未推</span>}
              <span className="gg-time">{c.relTime}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
