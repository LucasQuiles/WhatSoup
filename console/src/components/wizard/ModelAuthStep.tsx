import { type FC, useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'

interface ModelAuthStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
] as const

const MODEL_DEFAULTS = {
  conversation: 'claude-sonnet-4-6',
  extraction: 'claude-haiku-4-5-20251001',
  validation: 'claude-haiku-4-5-20251001',
  fallback: 'gpt-4.1',
} as const

type ModelRole = keyof typeof MODEL_DEFAULTS

const MODEL_ROLES: { key: ModelRole; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'extraction', label: 'Extraction' },
  { key: 'validation', label: 'Validation' },
  { key: 'fallback', label: 'Fallback' },
]

const selectStyle: React.CSSProperties = {
  background: 'var(--color-d1)',
  border: 'var(--bw) solid var(--b2)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--sp-2) var(--sp-3)',
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-t1)',
  width: '100%',
}

const inputStyle: React.CSSProperties = {
  ...selectStyle,
  paddingRight: 'var(--sp-8)',
}

/* ── Shared sub-sections ── */

const ModelSelectionSection: FC<{
  models: Record<ModelRole, string>
  onModelChange: (role: ModelRole, value: string) => void
}> = ({ models, onModelChange }) => (
  <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
    <span className="c-heading">Model Selection</span>
    {MODEL_ROLES.map(({ key, label }) => (
      <div key={key} className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
        <label className="c-label">{label}</label>
        <select
          value={models[key]}
          onChange={(e) => onModelChange(key, e.target.value)}
          style={selectStyle}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    ))}
  </div>
)

const ApiKeyInput: FC<{
  value: string
  onChange: (value: string) => void
}> = ({ value, onChange }) => {
  const [visible, setVisible] = useState(false)

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
      <label className="c-label">Anthropic API Key</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-ant-..."
          className="w-full font-mono"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute cursor-pointer"
          style={{
            right: 'var(--sp-2)',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--color-t3)',
          }}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <span className="c-body text-t3" style={{ fontSize: 'var(--font-size-xs)' }}>
        Required for chat instances. Stored securely in system keyring.
      </span>
    </div>
  )
}

/* ── Passive view ── */

const PassiveView: FC = () => (
  <div className="flex flex-col items-center text-center" style={{ gap: 'var(--sp-3)', padding: 'var(--sp-5) 0' }}>
    <Check size={32} className="text-s-ok" />
    <span className="c-heading">Passive lines don&apos;t require a model configuration.</span>
    <span className="c-body text-t3">
      This line will listen and store messages without AI responses.
    </span>
  </div>
)

/* ── Chat view ── */

const ChatView: FC<{
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}> = ({ data, onChange }) => {
  const models = (data.models as Record<ModelRole, string> | undefined) ?? { ...MODEL_DEFAULTS }
  const apiKey = (data.apiKey as string | undefined) ?? ''

  const handleModelChange = (role: ModelRole, value: string) => {
    onChange({ models: { ...models, [role]: value } })
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-5)' }}>
      <ModelSelectionSection models={models} onModelChange={handleModelChange} />
      <ApiKeyInput value={apiKey} onChange={(v) => onChange({ apiKey: v })} />
    </div>
  )
}

/* ── Agent view ── */

const AgentView: FC<{
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}> = ({ data, onChange }) => {
  const models = (data.models as Record<ModelRole, string> | undefined) ?? { ...MODEL_DEFAULTS }
  const apiKey = (data.apiKey as string | undefined) ?? ''
  const authMethod = (data.authMethod as 'api_key' | 'oauth' | undefined) ?? 'api_key'

  const handleModelChange = (role: ModelRole, value: string) => {
    onChange({ models: { ...models, [role]: value } })
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-5)' }}>
      <ModelSelectionSection models={models} onModelChange={handleModelChange} />

      {/* Auth Method */}
      <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
        <span className="c-heading">Auth Method</span>
        <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
          <label
            className="flex items-center cursor-pointer"
            style={{ gap: 'var(--sp-2)', color: 'var(--color-t2)' }}
          >
            <input
              type="radio"
              name="authMethod"
              value="api_key"
              checked={authMethod === 'api_key'}
              onChange={() => onChange({ authMethod: 'api_key' })}
              style={{ accentColor: 'var(--color-s-ok)' }}
            />
            <span className="c-body">API Key</span>
          </label>
          <label
            className="flex items-center cursor-pointer"
            style={{ gap: 'var(--sp-2)', color: 'var(--color-t2)' }}
          >
            <input
              type="radio"
              name="authMethod"
              value="oauth"
              checked={authMethod === 'oauth'}
              onChange={() => onChange({ authMethod: 'oauth' })}
              style={{ accentColor: 'var(--color-s-ok)' }}
            />
            <span className="c-body">Use existing Claude session</span>
          </label>
        </div>

        {authMethod === 'api_key' ? (
          <ApiKeyInput value={apiKey} onChange={(v) => onChange({ apiKey: v })} />
        ) : (
          <div
            className="c-body text-t3"
            style={{
              background: 'var(--color-d3)',
              borderRadius: 'var(--radius-sm)',
              padding: 'var(--sp-3)',
            }}
          >
            Requires active Claude CLI login on this machine.
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Main step component ── */

const ModelAuthStep: FC<ModelAuthStepProps> = ({ data, onChange }) => {
  const instanceType = data.type as string | undefined

  switch (instanceType) {
    case 'passive':
      return <PassiveView />
    case 'agent':
      return <AgentView data={data} onChange={onChange} />
    default:
      return <ChatView data={data} onChange={onChange} />
  }
}

export default ModelAuthStep
