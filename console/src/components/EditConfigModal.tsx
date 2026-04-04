import { type FC, useState, useCallback, useEffect } from 'react'
import { X, Save, Loader2, Settings, AlertTriangle } from 'lucide-react'
import ModelAuthStep from './wizard/ModelAuthStep'
import ConfigStep from './wizard/ConfigStep'
import { api } from '../lib/api'
import { DEFAULT_PROVIDER_ID } from '../lib/providers'

interface EditConfigModalProps {
  lineName: string
  open: boolean
  onClose: () => void
  onSaved: () => void
}

const EditConfigModal: FC<EditConfigModalProps> = ({ lineName, open, onClose, onSaved }) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'model' | 'config'>('config')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    api.getLine(lineName)
      .then((line) => {
        setFormData(line.config ?? {})
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [open, lineName])

  const patchForm = useCallback(
    (patch: Record<string, unknown>) => setFormData((d) => ({ ...d, ...patch })),
    [],
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await api.updateConfig(lineName, formData)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [lineName, formData, onSaved])

  if (!open) return null

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: 'var(--sp-2) var(--sp-4)',
    fontSize: 'var(--font-size-data)',
    cursor: 'pointer',
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid',
    borderBottomColor: active ? 'var(--color-s-ok)' : 'transparent',
    color: active ? 'var(--color-t1)' : 'var(--color-t4)',
    background: 'none',
    transition: 'border-color var(--dur-norm) var(--ease), color var(--dur-norm) var(--ease)',
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'var(--panel-wizard)',
          maxWidth: '90%',
          maxHeight: 'var(--modal-max-h)',
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
            <Settings size={16} className="text-t3" />
            <span className="c-heading-lg">Configure {lineName}</span>
          </div>
          <button onClick={onClose} className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex" style={{ borderBottom: 'var(--bw) solid var(--b1)', padding: '0 var(--sp-4)' }}>
          <button type="button" style={tabStyle(activeTab === 'config')} onClick={() => setActiveTab('config')}>Config</button>
          <button type="button" style={tabStyle(activeTab === 'model')} onClick={() => setActiveTab('model')}>Model &amp; Auth</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-6)' }}>
          {loading ? (
            <div className="flex items-center justify-center" style={{ padding: 'var(--sp-8)' }}>
              <Loader2 size={24} className="animate-spin text-t4" />
            </div>
          ) : activeTab === 'config' ? (
            <ConfigStep data={formData} onChange={patchForm} errors={{}} />
          ) : (
            <ModelAuthStep data={formData} onChange={patchForm} errors={{}} />
          )}
        </div>

        {/* Restart notice for provider changes */}
        {!loading && ((formData.agentOptions as Record<string, unknown> | undefined)?.provider ?? DEFAULT_PROVIDER_ID) !== DEFAULT_PROVIDER_ID && (
          <div className="flex items-center" style={{ gap: 'var(--sp-2)', padding: 'var(--sp-2) var(--sp-4)', fontSize: 'var(--font-size-xs)', color: 'var(--color-s-warn)', background: 'var(--s-warn-wash)' }}>
            <AlertTriangle size={12} style={{ flexShrink: 0 }} />
            <span>Non-default provider selected. A restart is required after saving for changes to take effect.</span>
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-between c-toolbar"
          style={{ borderTop: 'var(--bw) solid var(--b1)' }}
        >
          {error ? (
            <div className="flex items-center" style={{ gap: 'var(--sp-2)', fontSize: 'var(--font-size-data)', color: 'var(--color-s-crit)' }}>
              <X size={14} style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          ) : <div />}
          <div className="flex items-center" style={{ gap: 'var(--sp-3)' }}>
            <button className="c-btn c-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="c-btn c-btn-primary" onClick={handleSave} disabled={saving || loading}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save Config'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default EditConfigModal
