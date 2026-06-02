import { describe, it, expect } from 'vitest'
import { buildGroupCandidates, isMemberSelected, candidateToMember } from './group'
import type { Command, CommandEntry, CommandGroup } from './types'

const cmd = (name: string, command: string, source = 'pnpm'): Command => ({
  name, command, source, category: '',
})
const manual = (label: string, cwd: string, command: string, origin?: 'ai'): CommandEntry => ({
  id: label, label, cwd, command, ...(origin ? { origin } : {}),
})

describe('buildGroupCandidates', () => {
  it('groups scanned commands by directory with dirName:name label', () => {
    const groups = buildGroupCandidates([], [{ cwd: '/code/api', commands: [cmd('dev', 'pnpm dev')] }])
    expect(groups).toHaveLength(1)
    expect(groups[0].dirName).toBe('api')
    expect(groups[0].items[0]).toMatchObject({ label: 'api:dev', cwd: '/code/api', command: 'pnpm dev', origin: 'scan' })
  })

  it('merges manual command into matching directory group', () => {
    const groups = buildGroupCandidates(
      [manual('worker', '/code/api', 'php think run')],
      [{ cwd: '/code/api', commands: [cmd('dev', 'pnpm dev')] }],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((i) => i.label)).toEqual(['api:dev', 'worker'])
  })

  it('puts manual command with no bound dir into its own group', () => {
    const groups = buildGroupCandidates(
      [manual('lonely', '/elsewhere', 'echo hi')],
      [{ cwd: '/code/api', commands: [cmd('dev', 'pnpm dev')] }],
    )
    expect(groups.map((g) => g.cwd).sort()).toEqual(['/code/api', '/elsewhere'])
  })

  it('dedupes identical label+cwd+command across sources', () => {
    const groups = buildGroupCandidates(
      [manual('api:dev', '/code/api', 'pnpm dev')],
      [{ cwd: '/code/api', commands: [cmd('dev', 'pnpm dev')] }],
    )
    expect(groups[0].items).toHaveLength(1)
  })

  it('marks ai origin', () => {
    const groups = buildGroupCandidates([manual('ai-cmd', '/code/api', 'x', 'ai')], [])
    expect(groups[0].items[0].origin).toBe('ai')
  })
})

describe('isMemberSelected', () => {
  const group: CommandGroup = {
    id: 'g', name: 'G', members: [{ label: 'api:dev', cwd: '/code/api', command: 'pnpm dev' }],
  }
  it('matches by snapshot triple', () => {
    expect(isMemberSelected(group, { label: 'api:dev', cwd: '/code/api', command: 'pnpm dev', origin: 'scan' })).toBe(true)
    expect(isMemberSelected(group, { label: 'api:dev', cwd: '/code/api', command: 'other', origin: 'scan' })).toBe(false)
    expect(isMemberSelected(null, { label: 'x', cwd: 'y', command: 'z', origin: 'scan' })).toBe(false)
  })
})

describe('candidateToMember', () => {
  it('drops origin/source, keeps snapshot triple', () => {
    expect(candidateToMember({ label: 'a', cwd: 'b', command: 'c', origin: 'scan', source: 'pnpm' }))
      .toEqual({ label: 'a', cwd: 'b', command: 'c' })
  })
})
