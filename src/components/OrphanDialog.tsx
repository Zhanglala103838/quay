import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@heroui/react'
import type { Orphan } from '../lib/types'
import { killOrphan } from '../lib/ipc'
import { BorderBeam } from './ui/BorderBeam'

export function OrphanDialog({ orphans, onClose }: { orphans: Orphan[]; onClose: () => void }) {
  const [list, setList] = useState(orphans)
  if (list.length === 0) return null

  const kill = (o: Orphan) => {
    killOrphan(o.pgid)
    setList(list.filter((x) => x.runId !== o.runId))
  }

  return createPortal(
    <div className="modal">
      <div className="modal-box">
        <BorderBeam duration={8} color="var(--amber)" />
        <h3>⚠️ 上次异常退出,发现遗留进程仍在运行</h3>
        <p className="modal-sub">历史输出不可见(进程已脱离),但可在此停止,避免黑跑。</p>
        {list.map((o) => (
          <div key={o.runId} className="orphan-row">
            <span className="orphan-label">
              {o.label} <code>pid {o.pid}</code>
            </span>
            <Button size="sm" variant="danger" onPress={() => kill(o)}>
              停止
            </Button>
          </div>
        ))}
        <div className="modal-actions">
          <Button
            variant="danger"
            onPress={() => {
              list.forEach((o) => killOrphan(o.pgid))
              onClose()
            }}
          >
            全部停止
          </Button>
          <Button variant="outline" onPress={onClose}>
            全部保留
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
