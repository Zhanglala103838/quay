import { describe, it, expect } from 'vitest'
import { parseProposals } from './deepseek'
import type { ProjectContext } from './types'

const ctx = (tree: string[]): ProjectContext => ({
  root: '/r', tree, files: [], detectedSources: [],
})

describe('parseProposals', () => {
  it('解析合法 {commands:[...]} JSON', () => {
    const raw = JSON.stringify({
      commands: [{ name: '开发', command: 'pnpm dev', cwd: '', why: 'vite 项目' }],
    })
    const out = parseProposals(raw, ctx([]))
    expect(out).toEqual([{ name: '开发', command: 'pnpm dev', cwd: '', why: 'vite 项目' }])
  })

  it('剥离 ```json fence', () => {
    const raw = '```json\n{"commands":[{"name":"x","command":"go run .","cwd":"","why":""}]}\n```'
    expect(parseProposals(raw, ctx([])).length).toBe(1)
  })

  it('cwd 必须在 tree 里（目录以 / 结尾），否则整条丢弃', () => {
    const raw = JSON.stringify({
      commands: [
        { name: 'a', command: 'mvn', cwd: 'api', why: '' },
        { name: 'b', command: 'mvn', cwd: 'ghost', why: '' },
      ],
    })
    const out = parseProposals(raw, ctx(['api/', 'api/pom.xml']))
    expect(out.map((p) => p.name)).toEqual(['a'])
  })

  it('cwd 为 . 归一为根空串', () => {
    const raw = JSON.stringify({ commands: [{ name: 'a', command: 'make', cwd: '.', why: '' }] })
    expect(parseProposals(raw, ctx([]))[0].cwd).toBe('')
  })

  it('缺 name 或 command 的条目丢弃', () => {
    const raw = JSON.stringify({
      commands: [{ name: '', command: 'x', cwd: '', why: '' }, { name: 'y', command: '', cwd: '', why: '' }],
    })
    expect(parseProposals(raw, ctx([]))).toEqual([])
  })

  it('去重相同 name+command+cwd', () => {
    const raw = JSON.stringify({
      commands: [
        { name: 'a', command: 'x', cwd: '', why: '' },
        { name: 'a', command: 'x', cwd: '', why: '重复' },
      ],
    })
    expect(parseProposals(raw, ctx([])).length).toBe(1)
  })

  it('非 JSON → 返回 []，不抛', () => {
    expect(parseProposals('抱歉我无法回答', ctx([]))).toEqual([])
  })
})
