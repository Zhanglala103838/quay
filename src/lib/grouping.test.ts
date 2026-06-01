import { describe, it, expect } from 'vitest'
import { categorize } from './grouping'
import type { Command } from './types'

const cmd = (name: string, command: string, source: string, category = ''): Command => ({
  name, command, source, category,
})

describe('categorize', () => {
  it('infers category from name when category empty (npm scripts)', () => {
    const cats = categorize([cmd('dev', 'pnpm run dev', 'pnpm'), cmd('test', 'pnpm run test', 'pnpm')])
    expect(cats.find((c) => c.label === '开发')?.loose.some((l) => l.name === 'dev')).toBe(true)
    expect(cats.find((c) => c.label === '测试')?.loose.some((l) => l.name === 'test')).toBe(true)
  })

  it('honors explicit category from detector', () => {
    const cats = categorize([cmd('cargo run', 'cargo run', 'cargo', 'dev')])
    const dev = cats.find((c) => c.label === '开发')!
    expect(dev.loose[0].command).toBe('cargo run')
    expect(dev.loose[0].source).toBe('cargo')
  })

  it('mixes sources within one semantic category', () => {
    const cats = categorize([
      cmd('dev', 'pnpm run dev', 'pnpm'),
      cmd('cargo run', 'cargo run', 'cargo', 'dev'),
    ])
    const dev = cats.find((c) => c.label === '开发')!
    const names = dev.loose.map((l) => l.name).sort()
    expect(names).toEqual(['cargo run', 'dev'])
  })

  it('groups same-prefix npm scripts (>=2) into a prefix group', () => {
    const cats = categorize([
      cmd('db:migrate', 'pnpm run db:migrate', 'pnpm'),
      cmd('db:seed', 'pnpm run db:seed', 'pnpm'),
    ])
    const data = cats.find((c) => c.label === '数据')!
    expect(data.groups[0].prefix).toBe('db')
    expect(data.groups[0].items.length).toBe(2)
  })
})
