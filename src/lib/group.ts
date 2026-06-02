import type { Command, CommandEntry, CommandGroup, GroupMember } from './types'

/// 聚合组弹窗里的一条候选命令。origin 仅用于 UI 标记,落组时丢弃只留快照三字段。
export interface Candidate {
  label: string
  cwd: string
  command: string
  origin: 'manual' | 'ai' | 'scan'
  source?: string
}
/// 候选按目录(cwd)分组,弹窗按组渲染可勾选清单。
export interface CandidateGroup {
  cwd: string
  dirName: string
  items: Candidate[]
}

export const dirNameOf = (p: string) => p.split('/').filter(Boolean).pop() || p
/// 成员去重 key:label+cwd+command 三者全同才算同一条(对齐运行检测的 label 约定)。
export const memberKey = (m: { label: string; cwd: string; command: string }) =>
  JSON.stringify([m.label, m.cwd, m.command])

/// 合并「扫描命令 + 手动/AI 命令」为按目录分组的候选清单,组内去重。
/// scansByDir 顺序即渲染顺序(项目绑定目录在前);手动命令 cwd 不属任何绑定目录则单独成组。
export function buildGroupCandidates(
  manual: CommandEntry[],
  scansByDir: { cwd: string; commands: Command[] }[],
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  const ensure = (cwd: string) => {
    let g = groups.get(cwd)
    if (!g) {
      g = { cwd, dirName: dirNameOf(cwd), items: [] }
      groups.set(cwd, g)
    }
    return g
  }
  const seen = new Set<string>()
  const push = (g: CandidateGroup, cand: Candidate) => {
    const k = memberKey(cand)
    if (seen.has(k)) return
    seen.add(k)
    g.items.push(cand)
  }
  // 1) 扫描命令(保持目录顺序)
  for (const { cwd, commands } of scansByDir) {
    const g = ensure(cwd)
    for (const c of commands) {
      push(g, { label: `${g.dirName}:${c.name}`, cwd, command: c.command, origin: 'scan', source: c.source })
    }
  }
  // 2) 手动/AI 命令(并入所属 cwd 组,无则新组)
  for (const m of manual) {
    const g = ensure(m.cwd)
    push(g, { label: m.label, cwd: m.cwd, command: m.command, origin: m.origin === 'ai' ? 'ai' : 'manual' })
  }
  return [...groups.values()].filter((g) => g.items.length > 0)
}

export const candidateToMember = (c: Candidate): GroupMember => ({
  label: c.label,
  cwd: c.cwd,
  command: c.command,
})

/// 编辑态:判断某候选是否已是组成员(按快照三字段匹配)。
export function isMemberSelected(group: CommandGroup | null, c: Candidate): boolean {
  if (!group) return false
  const k = memberKey(c)
  return group.members.some((m) => memberKey(m) === k)
}
