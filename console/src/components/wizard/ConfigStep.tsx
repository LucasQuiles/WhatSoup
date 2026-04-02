import { type FC, type ChangeEvent, useCallback, useMemo } from 'react'
import { Check, Lock, List, MessageCircle, Users } from 'lucide-react'
import CollapsibleSection from '../CollapsibleSection'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { Field, TextInput, NumberInput, SelectInput, TextArea, CheckboxField } from './form-primitives'
import { labelStyle } from './form-styles'

interface ConfigStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
}

interface AgentOptions {
  cwd?: string
  sessionScope?: string
  sandboxPerChat?: boolean
  sandbox?: {
    allowedPaths?: string[]
    bash?: { enabled?: boolean; pathRestricted?: boolean }
  }
  mcp?: { send_media?: boolean }
  perUserDirs?: { enabled?: boolean; basePath?: string }
}

const ACCESS_OPTIONS = [
  {
    value: 'self_only',
    label: 'Admin Only',
    description: 'Only admin phone numbers can interact',
    icon: <Lock size={24} />,
    color: 'var(--color-s-ok)',
  },
  {
    value: 'allowlist',
    label: 'Allowlist',
    description: 'Approved contacts only',
    icon: <List size={24} />,
    color: 'var(--color-s-ok)',
  },
  {
    value: 'open_dm',
    label: 'Open DMs',
    description: 'Anyone can send direct messages',
    icon: <MessageCircle size={24} />,
    color: 'var(--color-s-ok)',
  },
  {
    value: 'groups_only',
    label: 'Groups Only',
    description: 'Only responds in group chats',
    icon: <Users size={24} />,
    color: 'var(--color-s-ok)',
  },
]

const SEARCH_MODES = ['Memory', 'Entity'] as const


const SESSION_SCOPE_DESCRIPTIONS: Record<string, string> = {
  single: 'One session, one admin \u2014 most restrictive',
  shared: 'One shared session across all chats',
  per_chat: 'Separate session per conversation \u2014 recommended',
}

const ConfigStep: FC<ConfigStepProps> = ({ data, onChange, errors }) => {
  const type = (data.type as string) ?? 'chat'
  const accessMode = (data.accessMode as string) ?? 'self_only'
  const systemPrompt = (data.systemPrompt as string) ?? ''
  const claudeMd = (data.claudeMd as string) ?? ''
  const agentOptions = useMemo<AgentOptions>(
    () => (data.agentOptions as AgentOptions) ?? {},
    [data.agentOptions],
  )
  const rateLimitPerHour = (data.rateLimitPerHour as number) ?? 60
  const maxTokens = (data.maxTokens as number) ?? 4096
  const tokenBudget = (data.tokenBudget as number) ?? 50000
  const pineconeIndex = (data.pineconeIndex as string) ?? ''
  const pineconeSearchMode = (data.pineconeSearchMode as string) ?? 'Memory'
  const pineconeRerank = (data.pineconeRerank as boolean) ?? false
  const pineconeTopK = (data.pineconeTopK as number) ?? 20
  const pineconeAllowedIndexes = (data.pineconeAllowedIndexes as string[]) ?? []
  const toolUpdateMode = (data.toolUpdateMode as string) ?? 'full'

  const handleFileUpload = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        onChange({ claudeMd: reader.result as string })
      }
      reader.readAsText(file)
    },
    [onChange],
  )

  const handleAgentOption = useCallback(
    (key: string, value: unknown) => {
      onChange({ agentOptions: { ...agentOptions, [key]: value } })
    },
    [agentOptions, onChange],
  )

  const handleSandboxBash = useCallback(
    (key: string, value: unknown) => {
      const currentBash = agentOptions.sandbox?.bash ?? {}
      onChange({
        agentOptions: {
          ...agentOptions,
          sandbox: {
            ...agentOptions.sandbox,
            bash: { ...currentBash, [key]: value },
          },
        },
      })
    },
    [agentOptions, onChange],
  )

  const handlePerUserDirs = useCallback(
    (key: string, value: unknown) => {
      const current = agentOptions.perUserDirs ?? { enabled: false, basePath: 'users' }
      onChange({
        agentOptions: {
          ...agentOptions,
          perUserDirs: { ...current, [key]: value },
        },
      })
    },
    [agentOptions, onChange],
  )

  const handleMcpOption = useCallback(
    (key: string, value: unknown) => {
      const current = agentOptions.mcp ?? {}
      onChange({
        agentOptions: {
          ...agentOptions,
          mcp: { ...current, [key]: value },
        },
      })
    },
    [agentOptions, onChange],
  )

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      {/* Use Defaults & Continue */}
      <button
        type="button"
        className="c-btn c-btn-ghost self-end"
        onClick={() => {
          /* no-op: leave formData unchanged, parent advances step */
        }}
        style={{ marginBottom: 'var(--sp-2)' }}
      >
        Use Defaults &amp; Continue
      </button>

      {/* 1. Access */}
      <CollapsibleSection title="Access" defaultOpen>
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <div>
            <label className="c-label" style={labelStyle}>
              <span className="inline-flex items-center" style={{ gap: 'var(--sp-1)' }}>
                Access Mode
                <Check size={14} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
              </span>
            </label>
            <CardSelector
              options={ACCESS_OPTIONS}
              selected={accessMode}
              onChange={(value) => onChange({ accessMode: value })}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* 2. Behavior */}
      <CollapsibleSection title="Behavior">
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          {/* System Prompt — hidden for passive lines */}
          {type !== 'passive' && (
            <Field label="System Prompt" error={errors.systemPrompt} confirmed={!errors.systemPrompt && systemPrompt.trim().length > 0}>
              <TextArea
                value={systemPrompt}
                onChange={(e) => onChange({ systemPrompt: e.target.value })}
                placeholder="You are a helpful assistant..."
                error={!!errors.systemPrompt}
                confirmed={!errors.systemPrompt && systemPrompt.trim().length > 0}
                minHeight={120}
              />
            </Field>
          )}

          {/* CLAUDE.md */}
          <div>
            <label className="c-label" style={labelStyle}>
              <span className="inline-flex items-center" style={{ gap: 'var(--sp-1)' }}>
                CLAUDE.md Instructions
                {claudeMd.trim().length > 0 && (
                  <Check size={14} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
                )}
              </span>
            </label>
            <div
              className="flex items-center justify-center cursor-pointer"
              style={{
                borderWidth: 'var(--bw)', borderStyle: 'dashed', borderColor: 'var(--b2)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--sp-4)',
                background: 'var(--color-d3)',
                marginBottom: 'var(--sp-2)',
              }}
            >
              <input
                type="file"
                accept=".md,.txt"
                onChange={handleFileUpload}
                style={{
                  width: '100%',
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-data)',
                  color: 'var(--color-t3)',
                }}
              />
            </div>
            <TextArea
              value={claudeMd}
              onChange={(e) => onChange({ claudeMd: e.target.value })}
              placeholder="Paste or edit CLAUDE.md contents..."
              confirmed={claudeMd.trim().length > 0}
              minHeight={120}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* 3. Permissions — only for agent type */}
      {type === 'agent' && (
        <CollapsibleSection title="Permissions">
          <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
            <Field label="Working Directory" error={errors.cwd} helper="Directory will be created if it doesn't exist" confirmed={!errors.cwd && (agentOptions.cwd ?? '').trim().length > 0}>
              <TextInput
                value={agentOptions.cwd ?? ''}
                onChange={(e) => handleAgentOption('cwd', e.target.value)}
                placeholder="/home/q/LAB/your-project"
                error={!!errors.cwd}
                confirmed={!errors.cwd && (agentOptions.cwd ?? '').trim().length > 0}
              />
            </Field>
            <Field label="Session Scope" helper={SESSION_SCOPE_DESCRIPTIONS[agentOptions.sessionScope ?? 'per_chat']} confirmed>
              <SelectInput
                value={agentOptions.sessionScope ?? 'per_chat'}
                onChange={(e) => handleAgentOption('sessionScope', e.target.value)}
                confirmed
              >
                <option value="single">single</option>
                <option value="shared">shared</option>
                <option value="per_chat">per_chat</option>
              </SelectInput>
            </Field>

            {/* Sandbox per chat */}
            <CheckboxField
              label="Isolate per-chat workspaces"
              checked={agentOptions.sandboxPerChat ?? true}
              onChange={(v) => handleAgentOption('sandboxPerChat', v)}
              helper="Each conversation gets its own sandboxed directory"
            />

            {/* Per-user directories */}
            <CheckboxField
              label="Enable per-user directories"
              checked={agentOptions.perUserDirs?.enabled ?? false}
              onChange={(v) => handlePerUserDirs('enabled', v)}
            />
            {(agentOptions.perUserDirs?.enabled ?? false) && (
              <Field label="Base path" helper="Create separate workspace folders per contact" confirmed={(agentOptions.perUserDirs?.basePath ?? 'users').trim().length > 0}>
                <TextInput
                  value={agentOptions.perUserDirs?.basePath ?? 'users'}
                  onChange={(e) => handlePerUserDirs('basePath', e.target.value)}
                  placeholder="users"
                  confirmed={(agentOptions.perUserDirs?.basePath ?? 'users').trim().length > 0}
                />
              </Field>
            )}

            {/* Bash enabled */}
            <CheckboxField
              label="Allow bash commands"
              checked={agentOptions.sandbox?.bash?.enabled ?? true}
              onChange={(v) => handleSandboxBash('enabled', v)}
              helper="Uncheck to completely disable shell access"
            />

            {/* Bash path restriction */}
            <CheckboxField
              label="Restrict bash to allowed paths"
              checked={agentOptions.sandbox?.bash?.pathRestricted ?? true}
              onChange={(v) => handleSandboxBash('pathRestricted', v)}
              helper="Bash commands can only access files within the sandbox"
            />

            {/* MCP send media */}
            <CheckboxField
              label="Allow sending media (images, files)"
              checked={agentOptions.mcp?.send_media ?? true}
              onChange={(v) => handleMcpOption('send_media', v)}
              helper="Enable the send_media MCP tool"
            />
          </div>
        </CollapsibleSection>
      )}

      {/* 4. Limits */}
      <CollapsibleSection title="Limits">
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <Field label="Messages per hour" confirmed>
            <NumberInput
              value={rateLimitPerHour}
              onChange={(e) => onChange({ rateLimitPerHour: Number(e.target.value) })}
              min={1}
              confirmed
            />
          </Field>
          <Field label="Max tokens per response" confirmed>
            <NumberInput
              value={maxTokens}
              onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
              min={1}
              confirmed
            />
          </Field>
          <Field label="Token budget per session" confirmed>
            <NumberInput
              value={tokenBudget}
              onChange={(e) => onChange({ tokenBudget: Number(e.target.value) })}
              min={1}
              confirmed
            />
          </Field>

          {/* Tool update verbosity */}
          <Field label="Tool update verbosity" helper="Minimal suppresses technical agent lifecycle messages" confirmed>
            <SelectInput
              value={toolUpdateMode}
              onChange={(e) => onChange({ toolUpdateMode: e.target.value })}
              confirmed
            >
              <option value="full">Full</option>
              <option value="minimal">Minimal</option>
            </SelectInput>
          </Field>
        </div>
      </CollapsibleSection>

      {/* 5. RAG (optional) */}
      <CollapsibleSection title="RAG" badge="optional">
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <Field label="Pinecone Index Name" confirmed={pineconeIndex.trim().length > 0}>
            <TextInput
              value={pineconeIndex}
              onChange={(e) => onChange({ pineconeIndex: e.target.value })}
              placeholder="my-index"
              confirmed={pineconeIndex.trim().length > 0}
            />
          </Field>
          <div>
            <label className="c-label" style={labelStyle}>
              <span className="inline-flex items-center" style={{ gap: 'var(--sp-1)' }}>
                Search Mode
                <Check size={14} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
              </span>
            </label>
            <div className="flex" style={{ gap: 0 }}>
              {SEARCH_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="c-btn"
                  onClick={() => onChange({ pineconeSearchMode: mode })}
                  style={{
                    background:
                      pineconeSearchMode === mode ? 'var(--color-s-ok)' : 'var(--color-d3)',
                    color:
                      pineconeSearchMode === mode ? 'var(--color-d0)' : 'var(--color-t3)',
                    borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
                    borderRadius:
                      mode === 'Memory'
                        ? 'var(--radius-sm) 0 0 var(--radius-sm)'
                        : '0 var(--radius-sm) var(--radius-sm) 0',
                    padding: 'var(--sp-2) var(--sp-4)',
                    fontSize: 'var(--font-size-data)',
                    cursor: 'pointer',
                    transition: 'background 0.15s ease, color 0.15s ease',
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <CheckboxField
            label="Rerank results"
            checked={pineconeRerank}
            onChange={(v) => onChange({ pineconeRerank: v })}
          />
          <Field label="TopK" confirmed>
            <NumberInput
              value={pineconeTopK}
              onChange={(e) => onChange({ pineconeTopK: Number(e.target.value) })}
              min={1}
              confirmed
            />
          </Field>
          <Field label="Allowed indexes" helper="Restrict which Pinecone indexes this instance can query" confirmed={pineconeAllowedIndexes.length > 0}>
            <TagInput
              values={pineconeAllowedIndexes}
              onChange={(values) => onChange({ pineconeAllowedIndexes: values })}
              placeholder="Index name"
            />
          </Field>
        </div>
      </CollapsibleSection>
    </div>
  )
}

export default ConfigStep
