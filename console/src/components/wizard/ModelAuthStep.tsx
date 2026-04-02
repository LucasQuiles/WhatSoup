import { type FC, useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { SelectInput } from './form-primitives'
import { inputStyle, errorStyle, helperStyle, labelStyle } from './form-styles'

const confirmCheckStyle: React.CSSProperties = { color: 'var(--wizard-accent)', flexShrink: 0 }

interface ModelAuthStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
}

const ANTHROPIC_MODELS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
] as const

const OPENAI_MODELS = [
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
] as const

const MODEL_DEFAULTS = {
  conversation: 'claude-sonnet-4-6',
  extraction: 'claude-haiku-4-5-20251001',
  validation: 'claude-haiku-4-5-20251001',
  fallback: 'gpt-4.1',
} as const

type ModelRole = keyof typeof MODEL_DEFAULTS

const ANTHROPIC_ROLES: { key: ModelRole; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'extraction', label: 'Extraction' },
  { key: 'validation', label: 'Validation' },
]

const passwordInputStyle: React.CSSProperties = {
  ...inputStyle,
  paddingRight: 'var(--sp-8)',
}

/* -- Shared sub-sections -- */

const ModelSelectionSection: FC<{
  models: Record<ModelRole, string>
  onModelChange: (role: ModelRole, value: string) => void
}> = ({ models, onModelChange }) => (
  <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
    <span className="c-heading">Model Selection</span>

    {/* Anthropic-only roles */}
    {ANTHROPIC_ROLES.map(({ key, label }) => (
      <div key={key} className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
        <label className="c-label" style={labelStyle}>{label}</label>
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SelectInput
              value={models[key]}
              onChange={(e) => onModelChange(key, e.target.value)}
              confirmed
            >
              <optgroup label="Anthropic">
                {ANTHROPIC_MODELS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
            </SelectInput>
          </div>
          <Check size={16} className="wizard-check" style={confirmCheckStyle} />
        </div>
      </div>
    ))}

    {/* Fallback role — OpenAI primary, Anthropic secondary */}
    <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
      <label className="c-label" style={labelStyle}>Fallback</label>
      <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SelectInput
            value={models.fallback}
            onChange={(e) => onModelChange('fallback', e.target.value)}
            confirmed
          >
            <optgroup label="OpenAI">
              {OPENAI_MODELS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
            <optgroup label="Anthropic">
              {ANTHROPIC_MODELS.filter((m) => m.value !== 'claude-opus-4-6').map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
          </SelectInput>
        </div>
        <Check size={16} className="wizard-check" style={confirmCheckStyle} />
      </div>
    </div>
  </div>
)

const ApiKeyInput: FC<{
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  helper: string
  error?: string
}> = ({ label, value, onChange, placeholder, helper, error }) => {
  const [visible, setVisible] = useState(false)
  const filled = value.trim().length > 0

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
      <label className="c-label" style={labelStyle}>{label}</label>
      <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
        <div className="relative" style={{ flex: 1, minWidth: 0 }}>
          <input
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full font-mono"
            style={{
              ...passwordInputStyle,
              borderColor: error ? 'var(--color-s-crit)' : filled ? 'var(--wizard-accent)' : 'var(--b2)',
            }}
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
        {!error && filled && (
          <Check size={16} className="wizard-check" style={confirmCheckStyle} />
        )}
      </div>
      {error && <div style={errorStyle}>{error}</div>}
      <span style={helperStyle}>{helper}</span>
    </div>
  )
}

/* -- Passive view -- */

const PassiveView: FC = () => (
  <div className="flex flex-col items-center text-center" style={{ gap: 'var(--sp-3)', padding: 'var(--sp-5) 0' }}>
    <Check size={32} className="text-s-ok" />
    <span className="c-heading">Passive lines don&apos;t require a model configuration.</span>
    <span className="c-body text-t3">
      This line will listen and store messages without AI responses.
    </span>
  </div>
)

/* -- Chat view -- */

const ChatView: FC<{
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
}> = ({ data, onChange, errors }) => {
  const models = (data.models as Record<ModelRole, string> | undefined) ?? { ...MODEL_DEFAULTS }
  const apiKey = (data.apiKey as string | undefined) ?? ''
  const openaiKey = (data.openaiKey as string | undefined) ?? ''

  const handleModelChange = (role: ModelRole, value: string) => {
    onChange({ models: { ...models, [role]: value } })
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      <ModelSelectionSection models={models} onModelChange={handleModelChange} />
      <ApiKeyInput
        label="Anthropic API Key"
        value={apiKey}
        onChange={(v) => onChange({ apiKey: v })}
        placeholder="sk-ant-..."
        helper="Required for chat instances. Stored securely in system keyring."
        error={errors.apiKey}
      />
      <ApiKeyInput
        label="OpenAI API Key"
        value={openaiKey}
        onChange={(v) => onChange({ openaiKey: v })}
        placeholder="sk-..."
        helper="Required for GPT fallback model. Stored securely."
        error={errors.openaiKey}
      />
    </div>
  )
}

/* -- Agent view -- */

const AgentView: FC<{
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
}> = ({ data, onChange, errors }) => {
  const models = (data.models as Record<ModelRole, string> | undefined) ?? { ...MODEL_DEFAULTS }
  const apiKey = (data.apiKey as string | undefined) ?? ''
  const openaiKey = (data.openaiKey as string | undefined) ?? ''
  const authMethod = (data.authMethod as 'api_key' | 'oauth' | undefined) ?? 'api_key'

  const handleModelChange = (role: ModelRole, value: string) => {
    onChange({ models: { ...models, [role]: value } })
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      <ModelSelectionSection models={models} onModelChange={handleModelChange} />

      {/* Auth Method */}
      <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
        <span className="c-heading">Auth Method</span>
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          <div className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: 'var(--sp-2)' }}>
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
          <Check size={16} className="wizard-check" style={confirmCheckStyle} />
        </div>

        {authMethod === 'api_key' ? (
          <>
            <ApiKeyInput
              label="Anthropic API Key"
              value={apiKey}
              onChange={(v) => onChange({ apiKey: v })}
              placeholder="sk-ant-..."
              helper="Required for chat instances. Stored securely in system keyring."
              error={errors.apiKey}
            />
            <ApiKeyInput
              label="OpenAI API Key"
              value={openaiKey}
              onChange={(v) => onChange({ openaiKey: v })}
              placeholder="sk-..."
              helper="Required for GPT fallback model. Stored securely."
              error={errors.openaiKey}
            />
          </>
        ) : (
          <>
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
            <ApiKeyInput
              label="OpenAI API Key"
              value={openaiKey}
              onChange={(v) => onChange({ openaiKey: v })}
              placeholder="sk-..."
              helper="Required for GPT fallback model. Stored securely."
              error={errors.openaiKey}
            />
          </>
        )}
      </div>
    </div>
  )
}

/* -- Main step component -- */

const ModelAuthStep: FC<ModelAuthStepProps> = ({ data, onChange, errors }) => {
  const instanceType = data.type as string | undefined

  switch (instanceType) {
    case 'passive':
      return <PassiveView />
    case 'agent':
      return <AgentView data={data} onChange={onChange} errors={errors} />
    default:
      return <ChatView data={data} onChange={onChange} errors={errors} />
  }
}

export default ModelAuthStep
