import { type FC, useId, useState } from 'react'
import { Tabs, Tab } from '../primitives/Tabs'
import { Button } from '../primitives/Button'
import { Check, Eye, EyeOff } from 'lucide-react'
import { RadioField, SelectInput, TextInput } from '../primitives'
import WizardStep from './WizardStep'

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

// passwordInputStyle replaced by c-input class + inline paddingRight

/* -- Tabbed model/key section -- */

/* tabStyle removed — using .c-tab CSS class */

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
    <div className="flex flex-col gap-[var(--sp-4)]">
      {/* Tab bar — Tabs primitive: roving tabindex, Arrow/Home/End, MANUAL activation. */}
      <Tabs label="Model provider" value={activeTab} onChange={(id) => setActiveTab(id as 'anthropic' | 'openai' | 'local')}>
        <Tab id="anthropic">Anthropic</Tab>
        <Tab id="openai">OpenAI</Tab>
        <Tab id="local" disabled disabledReason="Coming soon">Local</Tab>
      </Tabs>

      {/* Anthropic tab */}
      {activeTab === 'anthropic' && (
        <div role="tabpanel" id="tabpanel-anthropic" aria-labelledby="tab-anthropic" className="flex flex-col gap-[var(--sp-3)]">
          {ANTHROPIC_ROLES.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-[var(--sp-1)]">
              <label className="c-label c-field-label">{label}</label>
              <div className="flex items-center gap-[var(--sp-2)]">
                <div className="flex-1 min-w-0">
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
                <Check size={16} className="wizard-check" />
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
        <div role="tabpanel" id="tabpanel-openai" aria-labelledby="tab-openai" className="flex flex-col gap-[var(--sp-3)]">
          {OPENAI_ROLES.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-[var(--sp-1)]">
              <label className="c-label c-field-label">{label}</label>
              <div className="flex items-center gap-[var(--sp-2)]">
                <div className="flex-1 min-w-0">
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
                {models[key] && <Check size={16} className="wizard-check" />}
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
  const inputId = useId()
  const [visible, setVisible] = useState(false)
  const filled = value.trim().length > 0

  return (
    <div className="flex flex-col gap-[var(--sp-1)]">
      <label htmlFor={inputId} className="c-label c-field-label">{label}</label>
      <div className="flex items-center gap-[var(--sp-2)]">
        <div className="relative flex-1 min-w-0">
          <TextInput
            id={inputId}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full pr-[var(--sp-8)]"
            error={Boolean(error)}
            confirmed={filled}
          />
          <Button
            variant="ghost"
            size="xs"
            aria-label={visible ? 'Hide API key' : 'Show API key'}
            onClick={() => setVisible((v) => !v)}
            icon={visible ? <EyeOff size={16} /> : <Eye size={16} />}
            className="absolute cursor-pointer text-t3"
            style={{
              right: 'var(--sp-2)',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              padding: 0,
            }}
          />
        </div>
        {!error && filled && (
          <Check size={16} className="wizard-check" />
        )}
      </div>
      {error && <div className="c-error">{error}</div>}
      {helper && <span className="c-helper">{helper}</span>}
    </div>
  )
}

/* -- Passive view -- */

const PassiveView: FC = () => (
  <div className="flex flex-col items-center text-center gap-[var(--sp-3)] py-[var(--sp-5)] px-0">
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
    <div className="flex flex-col gap-[var(--sp-4)]">
      {/* Auth Method — Anthropic only */}
      <div className="flex flex-col gap-[var(--sp-2)]">
        <span className="c-heading">Anthropic Auth</span>
        <div className="flex items-center gap-[var(--sp-2)]">
          <div className="flex flex-1 min-w-0 gap-[var(--sp-4)]" role="radiogroup" aria-label="Anthropic Auth">
            <RadioField
              name="authMethod"
              value="api_key"
              checked={authMethod === 'api_key'}
              onChange={() => onChange({ authMethod: 'api_key' })}
              label="API Key"
              className="cursor-pointer"
              labelClassName="c-body"
            />
            <RadioField
              name="authMethod"
              value="oauth"
              checked={authMethod === 'oauth'}
              onChange={() => onChange({ authMethod: 'oauth' })}
              label="Existing Claude session"
              className="cursor-pointer"
              labelClassName="c-body"
            />
          </div>
          <Check size={16} className="wizard-check" />
        </div>
        {authMethod === 'oauth' && (
          <div className="c-body text-t3 bg-d3 rounded-sm p-[var(--sp-3)]">
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

  let content: React.ReactNode
  switch (instanceType) {
    case 'passive':
      content = <PassiveView />
      break
    case 'agent':
      content = <AgentView data={data} onChange={onChange} errors={errors} />
      break
    default:
      content = <ChatView data={data} onChange={onChange} errors={errors} />
  }

  return (
    <WizardStep title="Model & Auth">
      {content}
    </WizardStep>
  )
}

export default ModelAuthStep
