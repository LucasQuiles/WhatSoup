import { type FC, type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Lock, List, MessageCircle, Users } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { Field, TextInput, NumberInput, SelectInput, TextArea, CheckboxField } from './form-primitives'
import { helperStyle, labelStyle } from './form-styles'
import { validatePhone } from '../../lib/validation'
import { PROVIDERS, getProviderConfigFields } from '../../lib/providers'

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
  enabledPlugins?: Record<string, boolean>
  provider?: string
  providerConfig?: Record<string, unknown>
}

/** All known plugins. Order determines display order in the UI. */
const ALL_PLUGINS: { key: string; label: string; description: string; category: 'core' | 'dev' | 'integration' | 'lsp' }[] = [
  // Core
  { key: 'superpowers@superpowers-marketplace', label: 'Superpowers', description: 'Brainstorming, TDD, debugging, plans, verification', category: 'core' },
  { key: 'episodic-memory@superpowers-marketplace', label: 'Episodic Memory', description: 'Cross-session conversation memory', category: 'core' },
  { key: 'commit-commands@claude-plugins-official', label: 'Commit Commands', description: 'Git commit, push, PR workflows', category: 'core' },
  { key: 'elements-of-style@superpowers-marketplace', label: 'Elements of Style', description: 'Writing quality for docs and messages', category: 'core' },
  { key: 'claude-md-management@claude-plugins-official', label: 'CLAUDE.md Management', description: 'Audit and improve instruction files', category: 'core' },
  { key: 'hookify@claude-plugins-official', label: 'Hookify', description: 'Create hooks from conversation analysis', category: 'core' },
  // Dev
  { key: 'sdlc-os@sdlc-os-dev', label: 'SDLC-OS', description: 'Multi-agent SDLC workflow (45 agents, heavy context)', category: 'dev' },
  { key: 'tmup@tmup-dev', label: 'tmup', description: 'Multi-agent task coordination via tmux', category: 'dev' },
  { key: 'ralph-loop-v2@ralph-loop-v2-dev', label: 'Ralph Loop v2', description: 'Hardened iteration loops with telemetry', category: 'dev' },
  { key: 'plugin-dev@claude-plugins-official', label: 'Plugin Dev', description: 'Plugin creation and validation tools', category: 'dev' },
  { key: 'superpowers-developing-for-claude-code@superpowers-marketplace', label: 'CC Dev Docs', description: 'Claude Code official documentation', category: 'dev' },
  { key: 'feature-dev@claude-plugins-official', label: 'Feature Dev', description: 'Guided feature development workflow', category: 'dev' },
  { key: 'code-review@claude-plugins-official', label: 'Code Review', description: 'Confidence-based code review', category: 'dev' },
  { key: 'frontend-design@claude-plugins-official', label: 'Frontend Design', description: 'Production-grade UI generation', category: 'dev' },
  { key: 'security-guidance@claude-plugins-official', label: 'Security Guidance', description: 'Security best practices', category: 'dev' },
  // Integrations
  { key: 'microsoft_365@microsoft-365-dev', label: 'Microsoft 365', description: 'Email, calendar, Teams, SharePoint', category: 'integration' },
  { key: 'microsoft-docs@claude-plugins-official', label: 'Microsoft Docs', description: 'Official Microsoft documentation search', category: 'integration' },
  { key: 'superpowers-chrome@superpowers-marketplace', label: 'Chrome DevTools', description: 'Browser inspection and automation', category: 'integration' },
  { key: 'superpowers-lab@superpowers-marketplace', label: 'Superpowers Lab', description: 'Slack, Windows VM, tmux, duplicate detection', category: 'integration' },
  { key: 'playwright@claude-plugins-official', label: 'Playwright', description: 'Browser automation and testing', category: 'integration' },
  // LSP
  { key: 'pyright-lsp@claude-plugins-official', label: 'Pyright LSP', description: 'Python language server', category: 'lsp' },
  { key: 'typescript-lsp@claude-plugins-official', label: 'TypeScript LSP', description: 'TypeScript language server', category: 'lsp' },
]

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Core',
  dev: 'Development',
  integration: 'Integrations',
  lsp: 'Language Servers',
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

const detailPanelStyle: React.CSSProperties = {
  background: 'var(--color-d3)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--sp-4)',
  marginTop: 'var(--sp-3)',
  transition: 'opacity var(--dur-norm) var(--ease)',
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
  transition: 'border-color var(--dur-norm) var(--ease), color var(--dur-norm) var(--ease)',
})

/** Generate a sensible default system prompt based on instance type. */
function defaultSystemPrompt(name: string, type: string): string {
  const titleName = name.charAt(0).toUpperCase() + name.slice(1)
  if (type === 'agent') {
    return `You are ${titleName}, a helpful AI agent on WhatsApp. You have access to tools including file operations, web search, and code execution within your sandbox. Keep responses concise — they're delivered as WhatsApp messages. Ask clarifying questions when a request is ambiguous. Be direct, helpful, and personable.`
  }
  return `You are ${titleName}, a helpful AI assistant on WhatsApp. You respond to messages in a conversational, friendly tone. Keep responses concise and relevant — they're delivered as WhatsApp messages. If you don't know something, say so rather than guessing.`
}

/** Generate a sensible default CLAUDE.md for a new agent instance. */
function defaultClaudeMd(name: string, cwd: string): string {
  const titleName = name.charAt(0).toUpperCase() + name.slice(1)
  return `# ${titleName} — WhatsApp Agent

You are ${titleName}, an AI agent running on WhatsApp via WhatSoup.

## Identity
- You are a helpful, direct assistant reachable over WhatsApp
- You run as a Claude Code agent with tool access within your sandbox

## Workspace
- Your working directory is \`${cwd || '/home/q/LAB/' + name}\`
- You can create files, folders, and projects here freely
- Stay within this directory for all file operations

## Guardrails

### Stay in your lane
- Do NOT modify files outside your workspace
- Do NOT modify system configs, credentials, or infrastructure
- Do NOT restart, stop, or modify other WhatsApp instances

### Be conservative with resources
- Keep responses concise — they're delivered via WhatsApp
- Don't spawn unnecessary background processes
- Don't install system-level packages without explicit permission

## Capabilities
- Web search and research
- Create and edit documents, code, and scripts
- Read and analyze files sent to you
- Help with planning, writing, and brainstorming
`
}

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
  const name = (data.name as string) ?? ''

  // Pre-fill system prompt and claudeMd with sensible defaults (once only on mount)
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current) return
    prefilled.current = true
    const patch: Record<string, unknown> = {}
    if (type !== 'passive' && !systemPrompt.trim()) {
      patch.systemPrompt = defaultSystemPrompt(name, type)
    }
    if (type === 'agent' && !claudeMd.trim()) {
      patch.claudeMd = defaultClaudeMd(name, agentOptions.cwd ?? '')
    }
    if (Object.keys(patch).length > 0) onChange(patch)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only

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

  const handleProviderConfigOption = useCallback(
    (key: string, value: unknown) => {
      const current = { ...(agentOptions.providerConfig ?? {}) }
      if (value === undefined || value === '') {
        delete current[key]
      } else {
        current[key] = value
      }
      onChange({
        agentOptions: {
          ...agentOptions,
          providerConfig: current,
        },
      })
    },
    [agentOptions, onChange],
  )

  const handleProviderChange = useCallback(
    (newProvider: string) => {
      // Reset providerConfig when switching providers (fields differ)
      onChange({
        agentOptions: {
          ...agentOptions,
          provider: newProvider,
          providerConfig: {},
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

          {/* Provider selection */}
          <Field label="Provider" helper="AI backend for this agent instance" confirmed>
            <SelectInput
              value={agentOptions.provider ?? 'claude-cli'}
              onChange={(e) => handleProviderChange(e.target.value)}
              confirmed
            >
              {PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </SelectInput>
          </Field>

          {/* Provider-specific config fields */}
          {getProviderConfigFields(agentOptions.provider ?? 'claude-cli').map(field => {
            const fieldValue = agentOptions.providerConfig?.[field.key]
            const hasValue = fieldValue !== undefined && fieldValue !== ''
            return (
              <Field
                key={field.key}
                label={field.label}
                confirmed={hasValue}
              >
                {field.inputType === 'number' ? (
                  <NumberInput
                    value={(fieldValue as number) ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (!raw) { handleProviderConfigOption(field.key, undefined); return }
                      const n = Number(raw)
                      handleProviderConfigOption(field.key, Number.isNaN(n) ? undefined : n)
                    }}
                    placeholder={field.placeholder}
                    confirmed={hasValue}
                  />
                ) : (
                  <TextInput
                    value={(fieldValue as string) ?? ''}
                    onChange={(e) => handleProviderConfigOption(field.key, e.target.value.trim() || undefined)}
                    placeholder={field.placeholder}
                    confirmed={hasValue}
                  />
                )}
              </Field>
            )
          })}

          {/* Restart notice when provider != default */}
          {(agentOptions.provider ?? 'claude-cli') !== 'claude-cli' && (
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-s-warn)',
              padding: 'var(--sp-2) var(--sp-3)',
              background: 'var(--s-warn-wash)',
              borderRadius: 'var(--radius-sm)',
            }}>
              Non-default provider selected. Running instances require a restart after changing providers.
            </div>
          )}

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

          {/* Plugin selection */}
          <div style={{ ...detailPanelStyle, marginTop: 'var(--sp-2)' }}>
            <label className="c-label" style={labelStyle}>
              <span className="inline-flex items-center" style={{ gap: 'var(--sp-1)' }}>
                Enabled Plugins
                {agentOptions.enabledPlugins && (
                  <Check size={14} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
                )}
              </span>
            </label>
            <div style={helperStyle}>
              Select which plugins this instance loads. Disabled plugins save context tokens. Heavy plugins like SDLC-OS add ~66K tokens to every session.
            </div>
            <div className="flex items-center" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)', marginBottom: 'var(--sp-1)' }}>
              {agentOptions.enabledPlugins && Object.keys(agentOptions.enabledPlugins).length > 0 && (
                <button
                  type="button"
                  className="c-btn c-btn-ghost"
                  style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-1) var(--sp-2)' }}
                  onClick={() => handleAgentOption('enabledPlugins', {})}
                >
                  Reset to global defaults
                </button>
              )}
              <button
                type="button"
                className="c-btn c-btn-ghost"
                style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-1) var(--sp-2)' }}
                onClick={() => {
                  const all: Record<string, boolean> = {}
                  ALL_PLUGINS.forEach(p => { all[p.key] = true })
                  handleAgentOption('enabledPlugins', all)
                }}
              >
                Enable all
              </button>
              <button
                type="button"
                className="c-btn c-btn-ghost"
                style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-1) var(--sp-2)' }}
                onClick={() => {
                  const core: Record<string, boolean> = {}
                  ALL_PLUGINS.forEach(p => { core[p.key] = p.category === 'core' })
                  handleAgentOption('enabledPlugins', core)
                }}
              >
                Core only
              </button>
            </div>
            {(Object.entries(CATEGORY_LABELS) as [string, string][]).map(([cat, catLabel]) => {
              const plugins = ALL_PLUGINS.filter(p => p.category === cat)
              if (plugins.length === 0) return null
              return (
                <div key={cat} style={{ marginTop: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-t4)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', marginBottom: 'var(--sp-1)' }}>
                    {catLabel}
                  </div>
                  {plugins.map(plugin => {
                    const current = agentOptions.enabledPlugins ?? {}
                    const isEnabled = current[plugin.key] ?? true // default: inherit (enabled)
                    return (
                      <label
                        key={plugin.key}
                        className="flex items-start cursor-pointer"
                        style={{ gap: 'var(--sp-2)', padding: 'var(--sp-1) 0' }}
                      >
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => {
                            const updated = { ...current, [plugin.key]: e.target.checked }
                            handleAgentOption('enabledPlugins', updated)
                          }}
                          style={{ marginTop: '3px' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 'var(--font-size-data)', color: isEnabled ? 'var(--color-t1)' : 'var(--color-t4)' }}>
                            {plugin.label}
                          </div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-t5)' }}>
                            {plugin.description}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* Settings JSON — permissions for Claude Code */}
          <div style={{ ...detailPanelStyle, marginTop: 'var(--sp-2)' }}>
            <label className="c-label" style={labelStyle}>
              <span className="inline-flex items-center" style={{ gap: 'var(--sp-1)' }}>
                Claude Code Permissions (settings.json)
                {(data.settingsJson as Record<string, unknown> | undefined) && (
                  <Check size={14} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
                )}
              </span>
            </label>
            <div style={helperStyle}>
              Controls which tools Claude Code is allowed to use. Default grants full bypass with standard MCP wildcards.
            </div>
            <Field label="Template" confirmed>
              <SelectInput
                value={(data.settingsJsonMode as string) ?? 'default'}
                onChange={(e) => {
                  const mode = e.target.value
                  onChange({ settingsJsonMode: mode })
                  if (mode === 'default') {
                    onChange({ settingsJson: undefined, settingsJsonMode: mode })
                  }
                }}
                confirmed
              >
                <option value="default">Default (bypassPermissions + standard tools)</option>
                <option value="custom">Custom</option>
              </SelectInput>
            </Field>
            {(data.settingsJsonMode as string) === 'custom' && (
              <>
                <div style={{ marginTop: 'var(--sp-2)' }}>
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = () => {
                        try {
                          const parsed = JSON.parse(reader.result as string)
                          onChange({ settingsJson: parsed })
                        } catch {
                          /* invalid JSON — ignore */
                        }
                      }
                      reader.readAsText(file)
                    }}
                    style={{
                      width: '100%',
                      cursor: 'pointer',
                      fontSize: 'var(--font-size-data)',
                      color: 'var(--color-t3)',
                      marginBottom: 'var(--sp-2)',
                    }}
                  />
                </div>
                <TextArea
                  value={
                    (data.settingsJson as Record<string, unknown> | undefined)
                      ? JSON.stringify(data.settingsJson, null, 2)
                      : JSON.stringify({
                          permissions: {
                            allow: [
                              'Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Task',
                              'WebFetch', 'WebSearch', 'NotebookEdit',
                              'mcp__whatsoup__*', 'mcp__pinecone__*', 'mcp__playwright__*',
                              'mcp__render__*', 'mcp__plugin_*', 'mcp__claude_ai_*',
                              'mcp__google-workspace__*',
                            ],
                            deny: [],
                            defaultMode: 'bypassPermissions',
                          },
                        }, null, 2)
                  }
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value)
                      onChange({ settingsJson: parsed })
                    } catch {
                      /* let user keep typing — only save valid JSON */
                    }
                  }}
                  placeholder='{"permissions": {"allow": [...], "deny": [], "defaultMode": "bypassPermissions"}}'
                  confirmed={!!(data.settingsJson as Record<string, unknown> | undefined)}
                  minHeight={200}
                />
              </>
            )}
          </div>
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
                    transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
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
