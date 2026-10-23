/**
 * Settings modal — full settings panel with:
 * - Theme toggle (dark/light mode)
 * - Model selection dropdown
 * - API endpoint configuration
 * - Font size
 * - Auto-scroll toggle
 */

import { useEffect, useState } from 'react'
import { Button } from '../../components/Button.tsx'
import { store, type Settings } from '../../store.ts'
import { fetchConfig, updateConfig, type ServerConfig } from '../../chat/api.ts'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const settings = store.settings

  /** 服务端当前配置（含脱敏密钥），用于显示真实生效状态。 */
  const [server, setServer] = useState<ServerConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 打开面板时拉取服务端配置，避免界面显示与真实生效值不一致
  useEffect(() => {
    let alive = true
    void fetchConfig().then(cfg => {
      if (!alive || !cfg) return
      setServer(cfg)
      // 用服务端值回填（密钥除外），这样用户看到的就是真实配置
      store.updateSetting('model', cfg.model)
      store.updateSetting('baseURL', cfg.baseURL)
      store.updateSetting('maxSteps', cfg.maxSteps)
    })
    return () => {
      alive = false
    }
  }, [])

  /** 保存到服务端（热生效）。apiKey 为空时不提交，避免覆盖真实密钥。 */
  async function handleSave() {
    setSaving(true)
    setMessage(null)
    const result = await updateConfig({
      model: settings.model,
      baseURL: settings.baseURL,
      maxSteps: settings.maxSteps,
      ...(settings.apiKey.trim().length > 0 ? { apiKey: settings.apiKey.trim() } : {}),
    })
    setSaving(false)
    if (result.ok) {
      if (result.config) setServer(prev => (prev ? { ...prev, ...result.config } : prev))
      // 提交成功后清空输入框里的明文密钥
      store.updateSetting('apiKey', '')
      setMessage({ kind: 'ok', text: '已保存并生效' })
    } else {
      setMessage({ kind: 'err', text: result.error ?? '保存失败' })
    }
  }

  useEffect(() => {
    // Keep dark mode attribute in sync with settings
    if (settings.darkMode) {
      document.body.setAttribute('data-ds-dark-theme', '')
    } else {
      document.body.removeAttribute('data-ds-dark-theme')
    }
  }, [settings.darkMode])

  function handleToggleDarkMode() {
    store.updateSetting('darkMode', !settings.darkMode)
  }

  function handleModelChange(e: React.ChangeEvent<HTMLInputElement>) {
    store.updateSetting('model', e.target.value)
  }

  function handleBaseURLChange(e: React.ChangeEvent<HTMLInputElement>) {
    store.updateSetting('baseURL', e.target.value)
  }

  function handleApiKeyChange(e: React.ChangeEvent<HTMLInputElement>) {
    store.updateSetting('apiKey', e.target.value)
  }

  function handleFontSizeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    store.updateSetting('fontSize', e.target.value as Settings['fontSize'])
  }

  function handleToggleAutoScroll() {
    store.updateSetting('autoScroll', !settings.autoScroll)
  }

  return (
    <div className="dsh-modal-overlay" onClick={onClose}>
      <div className="dsh-modal dsh-modal-settings" onClick={e => e.stopPropagation()}>
        <div className="dsh-modal-header">
          <h2 className="dsh-modal-title">设置</h2>
          <Button variant="ghost" size="sm" onClick={onClose} title="关闭">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </Button>
        </div>

        <div className="dsh-modal-content">
          {/* ── Appearance ── */}
          <section className="dsh-modal-section">
            <h3 className="dsh-modal-section-title">外观</h3>
            
            <div className="dsh-modal-row">
              <span className="dsh-modal-row-label">深色模式</span>
              <ToggleSwitch
                checked={settings.darkMode}
                onChange={handleToggleDarkMode}
              />
            </div>
          </section>

          {/* ── Model ── */}
          <section className="dsh-modal-section">
            <h3 className="dsh-modal-section-title">模型</h3>
            
            <div className="dsh-modal-field">
              <label className="dsh-modal-label">模型</label>
              <input
                type="text"
                className="dsh-modal-input"
                value={settings.model}
                onChange={handleModelChange}
                placeholder="deepseek-chat"
                spellCheck={false}
              />
            </div>
          </section>

          {/* ── API ── */}
          <section className="dsh-modal-section">
            <h3 className="dsh-modal-section-title">API 配置</h3>
            
            <div className="dsh-modal-field">
              <label className="dsh-modal-label">Base URL</label>
              <input
                type="text"
                className="dsh-modal-input"
                value={settings.baseURL}
                onChange={handleBaseURLChange}
                placeholder="https://api.deepseek.com"
                spellCheck={false}
              />
            </div>

            <div className="dsh-modal-field">
              <label className="dsh-modal-label">API Key</label>
              <input
                type="password"
                className="dsh-modal-input"
                value={settings.apiKey}
                onChange={handleApiKeyChange}
                placeholder={server?.hasApiKey ? `已配置：${server.apiKeyMasked}（留空则不修改）` : '未配置，请输入 sk-...'}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="dsh-modal-field">
              <label className="dsh-modal-label">最大步数</label>
              <input
                type="number"
                min={1}
                max={50}
                className="dsh-modal-input"
                value={settings.maxSteps}
                onChange={e => store.updateSetting('maxSteps', Number(e.target.value))}
              />
            </div>

            <div className="dsh-modal-row">
              <span className="dsh-modal-row-label">
                当前 Provider：{server?.providerName ?? '未知'}
              </span>
              <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>

            {message ? (
              <p
                className="dsh-modal-hint"
                style={{ color: message.kind === 'ok' ? '#4ade80' : '#f87171' }}
              >
                {message.text}
              </p>
            ) : null}
          </section>

          {/* ── Display ── */}
          <section className="dsh-modal-section">
            <h3 className="dsh-modal-section-title">显示</h3>
            
            <div className="dsh-modal-field">
              <label className="dsh-modal-label">字体大小</label>
              <select
                className="dsh-modal-select"
                value={settings.fontSize}
                onChange={handleFontSizeChange}
              >
                <option value="small">小</option>
                <option value="medium">中</option>
                <option value="large">大</option>
              </select>
            </div>

            <div className="dsh-modal-row">
              <span className="dsh-modal-row-label">自动滚动</span>
              <ToggleSwitch
                checked={settings.autoScroll}
                onChange={handleToggleAutoScroll}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/* ── Toggle switch component ── */
function ToggleSwitch({ checked, onChange }: {
  checked: boolean
  onChange: () => void
}) {
  return (
    <button
      className={`dsh-toggle${checked ? ' dsh-toggle-active' : ''}`}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
    >
      <span className="dsh-toggle-thumb" />
    </button>
  )
}
