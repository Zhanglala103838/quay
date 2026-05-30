import { describe, it, expect } from 'vitest'
import { computeGraph } from './gitGraph'
import type { GitCommit } from './types'

const mk = (hash: string, parents: string[]): GitCommit => ({
  hash,
  parents,
  subject: hash,
  author: '',
  relTime: '',
  refs: [],
  unpushed: false,
})

const colsOf = (commits: GitCommit[]) =>
  Object.fromEntries(computeGraph(commits).rows.map((r) => [r.commit.hash, r.col]))

describe('computeGraph', () => {
  it('线性历史全在第 0 列', () => {
    const g = computeGraph([mk('c3', ['c2']), mk('c2', ['c1']), mk('c1', [])])
    expect(g.rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(g.width).toBe(1)
  })

  it('合并拓扑:分支占第 1 列,合并回第 0 列', () => {
    // M 合并 f1 进主线;M 父=[c2, f1],f1 父=[c2]
    const g = computeGraph([mk('M', ['c2', 'f1']), mk('f1', ['c2']), mk('c2', ['c1']), mk('c1', [])])
    expect(colsOf([mk('M', ['c2', 'f1']), mk('f1', ['c2']), mk('c2', ['c1']), mk('c1', [])])).toEqual(
      { M: 0, f1: 1, c2: 0, c1: 0 },
    )
    expect(g.width).toBe(2)
    // M 行应有一条分叉边到第 1 列(去 f1)
    const mRow = g.rows[0]
    expect(mRow.edges.some((e) => e.from === 0 && e.to === 1)).toBe(true)
  })

  it('两个独立 tip 共享父:第二个 tip 占新列后汇入', () => {
    const cols = colsOf([mk('A', ['c']), mk('B', ['c']), mk('c', [])])
    expect(cols.A).toBe(0)
    expect(cols.B).toBe(1)
    expect(cols.c).toBe(0)
  })

  it('根 commit 无父不报错', () => {
    const g = computeGraph([mk('only', [])])
    expect(g.rows[0].col).toBe(0)
    expect(g.rows[0].edges).toEqual([])
  })

  it('空输入', () => {
    const g = computeGraph([])
    expect(g.rows).toEqual([])
    expect(g.width).toBe(1)
  })
})
