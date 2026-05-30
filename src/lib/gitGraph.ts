import type { GitCommit } from './types'

/// 一段连线:从本行的 from 列连到下一行的 to 列(列号=lane 索引)。
export interface GraphEdge {
  from: number
  to: number
}
export interface GraphRow {
  commit: GitCommit
  col: number
  /// 本行 → 下一行之间的连线段。
  edges: GraphEdge[]
}
export interface GraphLayout {
  rows: GraphRow[]
  /// 总列数(用于 SVG 宽度)。
  width: number
}

function firstEmpty(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null)
  return i === -1 ? lanes.length : i
}

/// 给一串按时间逆序(子在前父在后)的 commit 算 lane 拓扑布局。
///
/// 核心:`lanes[i]` = 第 i 列当前"等待出现"的 commit hash。逐行处理:
/// - 找本 commit 所在列(等待它的最左列;没有则新开列=分支 tip)
/// - 其余等待它的列 = 合并进来,清空
/// - 第一个父继承本列,其余父各开新列(分叉)
/// - 连线在"已知下一行 commit"时计算:任何指向下一行 commit 的列都汇聚到它的列(合并/直连),
///   本节点的父列从节点列 col 根出(分叉根植于节点而非空列)。
export function computeGraph(commits: GitCommit[]): GraphLayout {
  const rows: GraphRow[] = []
  let lanes: (string | null)[] = []
  let width = 1

  commits.forEach((c, i) => {
    // 1. 本 commit 的列
    const myLanes: number[] = []
    lanes.forEach((h, l) => {
      if (h === c.hash) myLanes.push(l)
    })
    let col: number
    if (myLanes.length) {
      col = myLanes[0]
    } else {
      col = firstEmpty(lanes)
      lanes[col] = c.hash
    }

    // 2. 算进入下一行的 lane 状态 + 记录本节点的父列(用于连线根植)
    const after = lanes.slice()
    for (let k = 1; k < myLanes.length; k++) after[myLanes[k]] = null // 合并的列清空
    const parentLanes = new Set<number>()
    if (c.parents.length) {
      after[col] = c.parents[0]
      parentLanes.add(col)
      for (let k = 1; k < c.parents.length; k++) {
        const nc = firstEmpty(after)
        after[nc] = c.parents[k]
        parentLanes.add(nc)
      }
    } else {
      after[col] = null
    }
    while (after.length && after[after.length - 1] == null) after.pop()

    // 3. 本行 → 下一行连线(已知下一行 commit)
    const edges: GraphEdge[] = []
    const next = commits[i + 1]
    if (next) {
      let nextCol = -1
      after.forEach((h, l) => {
        if (h === next.hash && nextCol === -1) nextCol = l
      })
      for (let l = 0; l < after.length; l++) {
        if (after[l] == null) continue
        const to = after[l] === next.hash && nextCol !== -1 ? nextCol : l
        const from = parentLanes.has(l) ? col : l // 父列从节点根出
        edges.push({ from, to })
      }
    }

    width = Math.max(width, lanes.length, after.length, col + 1)
    rows.push({ commit: c, col, edges })
    lanes = after
  })

  return { rows, width }
}
