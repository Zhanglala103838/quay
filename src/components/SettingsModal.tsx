import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings, DEEPSEEK_MODELS, type DeepSeekSettings } from '../state/settings'
import { testConnection } from '../lib/deepseek'
import { BorderBeam } from './ui/BorderBeam'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { deepseek, save, render, saveRender } = useSettings()
  const [form, setForm] = useState<DeepSeekSettings>(deepseek)
  const [gpu, setGpu] = useState(render.gpuAcceleration)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const set = (k: keyof DeepSeekSettings, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setResult(null)
  }

  const doSave = () => {
    save(form)
    saveRender({ gpuAcceleration: gpu })
    onClose()
  }

  const doTest = async () => {
    save(form) // 用当前输入测试
    setTesting(true)
    setResult(null)
    setResult(await testConnection())
    setTesting(false)
  }

  return createPortal(
    <div className="modal" onMouseDown={onClose}>
      <div className="modal-box settings-box" onMouseDown={(e) => e.stopPropagation()}>
        <BorderBeam duration={7} />
        <h3>⚙️ 设置</h3>

        <div className="settings-section-label">DeepSeek · 智能能力</div>
        <p className="modal-sub">
          配置 DeepSeek 后，可对命令做「智能分组」与「用途解释」。Key 仅存本机 localStorage，不上传。
        </p>

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            value={form.apiKey}
            placeholder="sk-..."
            autoComplete="off"
            onChange={(e) => set('apiKey', e.target.value)}
          />
        </div>

        <div className="field">
          <label>模型</label>
          <input
            value={form.model}
            placeholder="deepseek-chat"
            list="dl-ds-model"
            onChange={(e) => set('model', e.target.value)}
          />
          <datalist id="dl-ds-model">
            {DEEPSEEK_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="field-chips">
            {DEEPSEEK_MODELS.map((m) => (
              <button
                type="button"
                key={m}
                className={'field-chip' + (form.model === m ? ' active' : '')}
                onClick={() => set('model', m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Base URL</label>
          <input
            value={form.baseUrl}
            placeholder="https://api.deepseek.com"
            onChange={(e) => set('baseUrl', e.target.value)}
          />
        </div>

        {/* 测试连接归属 DeepSeek 配置块:验证当前 key/model/baseUrl 是否可用 */}
        <div className="settings-test-row">
          <button className="modal-btn accent" disabled={testing} onClick={doTest}>
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {result && (
          <div className={'test-result ' + (result.ok ? 'ok' : 'err')}>{result.message}</div>
        )}

        <div className="settings-divider" />
        <div className="settings-section-label">渲染</div>

        <button
          type="button"
          className="toggle-row"
          role="switch"
          aria-checked={gpu}
          onClick={() => setGpu((v) => !v)}
        >
          <div className="toggle-row-text">
            <div className="toggle-row-title">GPU 渲染加速</div>
            <div className="toggle-row-desc">
              {gpu
                ? '激活终端用 WebGL（GPU）渲染，大量输出更流畅'
                : '已关闭，退回 DOM 渲染（纯 CPU，更省电/更兼容，海量输出时偏卡）'}
            </div>
          </div>
          <span className={'switch' + (gpu ? ' on' : '')}>
            <span className="switch-knob" />
          </span>
        </button>

        <div className="modal-actions">
          <button className="modal-btn primary" onClick={doSave}>
            保存
          </button>
          <button className="modal-btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
