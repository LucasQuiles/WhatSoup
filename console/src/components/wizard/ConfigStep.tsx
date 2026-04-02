import { type FC, type ChangeEvent, useCallback, useMemo, useState } from 'react'
import { Check, Lock, List, MessageCircle, Users } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { Field, TextInput, NumberInput, SelectInput, TextArea, CheckboxField } from './form-primitives'
import { helperStyle, labelStyle } from './form-styles'

interface ConfigStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
  onSkip?: () => void
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
    color: 'var(--wizard-accent)',
  },
  {
    value: 'allowlist',
    label: 'Allowlist',
    description: 'Approved contacts only',
    icon: <List size={24} />,
    color: 'var(--wizard-accent)',
  },
  {
    value: 'open_dm',
    label: 'Open DMs',
    description: 'Anyone can send direct messages',
    icon: <MessageCircle size={24} />,
    color: 'var(--wizard-accent)',
  },
  {
    value: 'groups_only',
    label: 'Groups Only',
    description: 'Only responds in group chats',
    icon: <Users size={24} />,
    color: 'var(--wizard-accent)',
  },
]

function validatePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

const detailPanelStyle: React.CSSProperties = {
  background: 'var(--color-d3)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--sp-4)',
  marginTop: 'var(--sp-3)',
  transition: 'opacity 0.2s ease',
}

const SEARCH_MODES = ['Memory', 'Entity'] as const


const SESSION_SCOPE_DESCRIPTIONS: Record<string, string> = {
  single: 'One session, one admin \u2014 most restrictive',
  shared: 'One shared session across all chats',
  per_chat: 'Separate session per conversation \u2014 recommended',
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: 'var(--sp-2) var(--sp-4)',
  fontSize: 'var(--font-size-data)',
  cursor: 'pointer',
  borderBottomWidth: '2px',
  borderBottomStyle: 'solid',
  borderBottomColor: active ? 'var(--wizard-accent)' : 'transparent',
  color: active ? 'var(--color-t1)' : 'var(--color-t4)',
  background: 'none',
  transition: 'border-color 0.2s ease, color 0.2s ease',
})

const ConfigStep: FC<ConfigStepProps> = ({ data, onChange, errors, onSkip }) => {
  const type = (data.type as string) ?? 'chat'
  const accessMode = (data.accessMode as string) ?? 'self_only'
  const allowedContacts = (data.allowedContacts as string[]) ?? []
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

  const [activeTab, setActiveTab] = useState<string>('access')



  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      {/* Tab bar */}
      <div className="flex" style={{ borderBottomWidth: 'var(--bw)', borderBottomStyle: 'solid', borderBottomColor: 'var(--b1)' }}>
        <button type="button" style={tabStyle(activeTab === 'access')} onClick={() => setActiveTab('access')}>Access</button>
        <button type="button" style={tabStyle(activeTab === 'behavior')} onClick={() => setActiveTab('behavior')}>Behavior</button>
        {type === 'agent' && (
          <button type="button" style={tabStyle(activeTab === 'permissions')} onClick={() => setActiveTab('permissions')}>Permissions</button>
        )}
        <button type="button" style={tabStyle(activeTab === 'limits')} onClick={() => setActiveTab('limits')}>Limits</button>
        <button type="button" style={tabStyle(activeTab === 'rag')} onClick={() => setActiveTab('rag')}>
          RAG <span style={{ color: 'var(--color-t5)', fontSize: 'var(--font-size-xs)' }}>(optional)</span>
        </button>
      </div>

      {/* 1. Access */}
      {activeTab === 'access' && (
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

          {accessMode === 'self_only' && (
            <div style={detailPanelStyle}>
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Admin Only</span>
              <p className="c-body text-t3">Only phone numbers listed as admin can interact with this line. All other messages are silently ignored. This is the most restrictive and secure setting.</p>
            </div>
          )}

          {accessMode === 'allowlist' && (
            <div style={detailPanelStyle}>
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Allowlist</span>
              <p className="c-body text-t3">Only approved contacts can interact. New contacts will be held in a pending queue until an admin approves or blocks them.</p>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <label className="c-label" style={labelStyle}>Pre-approved contacts</label>
                <TagInput
                  values={allowedContacts}
                  onChange={(values) => onChange({ allowedContacts: values.map(v => v.replace(/\D/g, '')) })}
                  placeholder="Add phone number"
                  validate={validatePhone}
                  accentColor={allowedContacts.length > 0 ? 'var(--wizard-accent)' : undefined}
                />
                <div style={helperStyle}>These contacts will be automatically approved when they first message.</div>
              </div>
            </div>
          )}

          {accessMode === 'open_dm' && (
            <div style={detailPanelStyle}>
              <span className="c-heading" style={{ color: 'var(--color-s-warn)' }}>Open DMs — Use Caution</span>
              <p className="c-body text-t3">Anyone can send a direct message and the agent will respond. The agent has access to its configured tools and workspace. Only use this if you trust all potential contacts or have strict sandbox restrictions in the Permissions tab.</p>
            </div>
          )}

          {accessMode === 'groups_only' && (
            <div style={detailPanelStyle}>
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Groups Only</span>
              <p className="c-body text-t3">This line only responds in group chats when mentioned. Direct messages are ignored. Useful for shared team bots.</p>
            </div>
          )}
        </div>
      )}

      {/* 2. Behavior */}
      {activeTab === 'behavior' && (
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
      )}

      {/* 3. Permissions — only for agent type */}
      {activeTab === 'permissions' && type === 'agent' && (
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
      )}

      {/* 4. Limits */}
      {activeTab === 'limits' && (
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
      )}

      {/* 5. RAG */}
      {activeTab === 'rag' && (
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
                      pineconeSearchMode === mode ? 'var(--wizard-accent)' : 'var(--color-d3)',
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
              accentColor={pineconeAllowedIndexes.length > 0 ? 'var(--wizard-accent)' : undefined}
            />
          </Field>
        </div>
      )}
      {/* Skip — sticky at bottom, right-aligned */}
      {onSkip && (
        <div className="flex justify-end" style={{ marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-3)', borderTopWidth: 'var(--bw)', borderTopStyle: 'solid', borderTopColor: 'var(--b1)' }}>
          <button
            type="button"
            className="c-btn c-btn-ghost"
            onClick={onSkip}
            style={{ fontSize: 'var(--font-size-data)' }}
          >
            Skip — Use Defaults
          </button>
        </div>
      )}
    </div>
  )
}

export default ConfigStep
