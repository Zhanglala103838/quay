import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { BorderBeam } from './ui/BorderBeam'
import { scanDir } from '../lib/ipc'
import {
  buildGroupCandidates,
  candidateToMember,
  isMemberSelected,
  memberKey,
  type Candidate,
  type CandidateGroup,
} from '../lib/group'
import type { CommandEntry, CommandGroup, GroupMember } from '../lib/types'

/// 聚合命令组的新建/编辑弹窗。打开时并发扫描项目所有绑定目录,
/// 合并「扫描命令 + 手动/AI 命令」成可勾选清单(按目录分组),选若干条 → 落组。
export function CommandGroupModal({
  directories,
  manualCommands,
  initial,
  onSubmit,
  onCancel,
}: {
  directories: string[]
  manualCommands: CommandEntry[]
  initial: CommandGroup | null
  onSubmit: (name: string, members: GroupMember[]) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [groups, setGroups] = useState<CandidateGroup[] | null>(null)
  // 选中集合:memberKey -> Candidate(保留 cwd/command 用于落组)
  const [selected, setSelected] = useState<Map<string, Candidate>>(new Map())

  useEffect(() => {
    let alive = true
    Promise.all(
      directories.map((cwd) =>
        scanDir(cwd)
          .then((r) => ({ cwd, commands: r.commands }))
          .catch(() => ({ cwd, commands: [] })),
      ),
    ).then((scans) => {
      if (!alive) return
      const cands = buildGroupCandidates(manualCommands, scans)
      setGroups(cands)
      // 编辑态:预选已有成员
      const pre = new Map<string, Candidate>()
      for (const g of cands) {
        for (const c of g.items) {
          if (isMemberSelected(initial, c)) pre.set(memberKey(c), c)
        }
      }
      setSelected(pre)
    })
    return () => {
      alive = false
    }
    // 仅打开时扫描一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (c: Candidate) =>
    setSelected((prev) => {
      const next = new Map(prev)
      const k = memberKey(c)
      if (next.has(k)) next.delete(k)
      else next.set(k, c)
      return next
    })

  const members = useMemo(() => [...selected.values()].map(candidateToMember), [selected])
  const canSave = name.trim().length > 0 && members.length > 0

  return createPortal(
    <div className="modal" onMouseDown={onCancel}>
      <div className="modal-box group-modal" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>{initial ? '编辑命令组' : '新建命令组'}</h3>
        <input
          className="group-name-input"
          value={name}
          placeholder="组名(如 全栈启动)"
          maxLength={20}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        {groups === null ? (
          <div className="group-loading">扫描目录中…</div>
        ) : groups.length === 0 ? (
          <div className="group-empty">该项目暂无可选命令(先绑定目录或新增手动命令)。</div>
        ) : (
          <div className="group-pick-list">
            {groups.map((g) => (
              <div className="group-pick-dir" key={g.cwd}>
                <div className="group-pick-dirname" title={g.cwd}>
                  📁 {g.dirName}
                </div>
                {g.items.map((c) => {
                  const on = selected.has(memberKey(c))
                  return (
                    <label className={'group-pick-row' + (on ? ' on' : '')} key={memberKey(c)}>
                      <input type="checkbox" checked={on} onChange={() => toggle(c)} />
                      {c.origin === 'ai' && <span className="cmd-ai-tag" title="AI 识别">◆</span>}
                      <span className="group-pick-name">{c.label}</span>
                      <code className="group-pick-cmd">{c.command}</code>
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="modal-btn primary" disabled={!canSave} onClick={() => onSubmit(name.trim(), members)}>
            {initial ? '保存' : '创建'}组 · 已选 {members.length}
          </button>
          <button className="modal-btn ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
