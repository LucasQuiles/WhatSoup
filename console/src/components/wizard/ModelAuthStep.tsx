import { type FC, useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { SelectInput } from './form-primitives'
import { inputStyle, errorStyle, helperStyle, labelStyle, confirmCheckStyle } from './form-styles'

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
  fallback: '',
  openaiExtraction: '',
  openaiValidation: '',
} as const

type ModelRole = keyof typeof MODEL_DEFAULTS

const ANTHROPIC_ROLES: { key: ModelRole; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'extraction', label: 'Extraction' },
  { key: 'validation', label: 'Validation' },
]

const OPENAI_ROLES: { key: ModelRole; label: string }[] = [
  { key: 'fallback', label: 'Fallback / Conversation' },
  { key: 'openaiExtraction', label: 'Extraction' },
  { key: 'openaiValidation', label: 'Validation' },
]

const passwordInputStyle: React.CSSProperties = {
  ...inputStyle,
  paddingRight: 'var(--sp-8)',
}

/* -- Tabbed model/key section -- */

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: 'var(--sp-2) var(--sp-4)',
  fontSize: 'var(--font-size-data)',
  cursor: 'pointer',
  borderBottomWidth: '2px',
  borderBottomStyle: 'solid',
  borderBottomColor: active ? 'var(--wizard-accent)' : 'transparent',
  color: active ? 'var(--color-t1)' : 'var(--color-t4)',
  background: 'none',
  transition: 'border-color var(--dur-norm) var(--ease), color var(--dur-norm) var(--ease)',
})

const ModelAndKeyTabs: FC<{
  models: Record<ModelRole, string>
  onModelChange: (role: ModelRole, value: string) => void
  apiKey: string
  openaiKey: string
  onApiKeyChange: (v: string) => void
  onOpenaiKeyChange: (v: string) => void
  errors: Record<string, string>
  hideAnthropicKey?: boolean
}> = ({ models, onModelChange, apiKey, openaiKey, onApiKeyChange, onOpenaiKeyChange, errors, hideAnthropicKey }) => {
  const [activeTab, setActiveTab] = useState<'anthropic' | 'openai' | 'local'>('anthropic')

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      {/* Tab bar */}
      <div className="flex" style={{ borderBottomWidth: 'var(--bw)', borderBottomStyle: 'solid', borderBottomColor: 'var(--b1)' }}>
        <button type="button" style={tabStyle(activeTab === 'anthropic')} onClick={() => setActiveTab('anthropic')}>
          Anthropic
        </button>
        <button type="button" style={tabStyle(activeTab === 'openai')} onClick={() => setActiveTab('openai')}>
          OpenAI
        </button>
        <button
          type="button"
          style={{ ...tabStyle(false), opacity: 0.4, cursor: 'not-allowed' }}
          title="Coming soon"
          disabled
        >
          Local
        </button>
      </div>

      {/* Anthropic tab */}
      {activeTab === 'anthropic' && (
        <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
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
                    {ANTHROPIC_MODELS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </SelectInput>
                </div>
                <Check size={16} className="wizard-check" style={confirmCheckStyle} />
              </div>
            </div>
          ))}
          {!hideAnthropicKey && (
            <ApiKeyInput
              label="API Key"
              value={apiKey}
              onChange={onApiKeyChange}
              placeholder="sk-ant-..."
              error={errors.apiKey}
            />
          )}
        </div>
      )}

      {/* OpenAI tab */}
      {activeTab === 'openai' && (
        <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
          {OPENAI_ROLES.map(({ key, label }) => (
            <div key={key} className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
              <label className="c-label" style={labelStyle}>{label}</label>
              <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <SelectInput
                    value={models[key]}
                    onChange={(e) => onModelChange(key, e.target.value)}
                    confirmed={!!models[key]}
                  >
                    <option value="">None</option>
                    {OPENAI_MODELS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </SelectInput>
                </div>
                {models[key] && <Check size={16} className="wizard-check" style={confirmCheckStyle} />}
              </div>
            </div>
          ))}
          <ApiKeyInput
            label="API Key"
            value={openaiKey}
            onChange={onOpenaiKeyChange}
            placeholder="sk-..."
            error={errors.openaiKey}
          />
        </div>
      )}
    </div>
  )
}

const ApiKeyInput: FC<{
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  helper?: string
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
      {helper && <span style={helperStyle}>{helper}</span>}
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
    <ModelAndKeyTabs
      models={models}
      onModelChange={handleModelChange}
      apiKey={apiKey}
      openaiKey={openaiKey}
      onApiKeyChange={(v) => onChange({ apiKey: v })}
      onOpenaiKeyChange={(v) => onChange({ openaiKey: v })}
      errors={errors}
    />
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
      {/* Auth Method — Anthropic only */}
      <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
        <span className="c-heading">Anthropic Auth</span>
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          <div className="flex" style={{ flex: 1, minWidth: 0, gap: 'var(--sp-4)' }}>
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
              />
              <span className="c-body">Existing Claude session</span>
            </label>
          </div>
          <Check size={16} className="wizard-check" style={confirmCheckStyle} />
        </div>
        {authMethod === 'oauth' && (
          <div
            className="c-body text-t3"
            style={{ background: 'var(--color-d3)', borderRadius: 'var(--radius-sm)', padding: 'var(--sp-3)' }}
          >
            Requires active Claude CLI login on this machine.
          </div>
        )}
      </div>

      {/* Tabbed model + key config */}
      <ModelAndKeyTabs
        models={models}
        onModelChange={handleModelChange}
        apiKey={authMethod === 'api_key' ? apiKey : ''}
        openaiKey={openaiKey}
        onApiKeyChange={(v) => onChange({ apiKey: v })}
        onOpenaiKeyChange={(v) => onChange({ openaiKey: v })}
        errors={errors}
        hideAnthropicKey={authMethod === 'oauth'}
      />
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
