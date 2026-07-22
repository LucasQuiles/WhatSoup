import { type FC, type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Lock, List, MessageCircle, Users } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { Field, TextInput, NumberInput, SelectInput, FileInput, TextArea, CheckboxField } from '../primitives'
// form-styles static exports replaced by CSS classes (c-field-label, c-helper)
import { PROVIDERS, getProviderConfigFields, DEFAULT_PROVIDER_ID } from '../../lib/providers'
import { defaultAgentWorkspacePath } from '../../lib/agent-cwd'
import { ACCESS_MODE_DETAILS, ACCESS_MODE_VALUES, type AccessModeValue } from '../../lib/access-modes'
import { Tabs, Tab } from '../primitives/Tabs'
import { Button } from '../primitives/Button'

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
  fallbackProvider?: string
  fallbackModel?: string
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

const ACCESS_ICONS = {
  self_only: <Lock size={24} />,
  allowlist: <List size={24} />,
  open_dm: <MessageCircle size={24} />,
  groups_only: <Users size={24} />,
} satisfies Record<AccessModeValue, ReactNode>

const ACCESS_OPTIONS = ACCESS_MODE_VALUES.map((value) => ({
  value,
  label: ACCESS_MODE_DETAILS[value].label,
  description: ACCESS_MODE_DETAILS[value].description,
  icon: ACCESS_ICONS[value],
  color: 'var(--wizard-accent)',
}))

// detailPanelStyle replaced by Tailwind classes: bg-d3 rounded-md p-[var(--sp-4)] mt-[var(--sp-3)]

const SEARCH_MODES = ['Memory', 'Entity'] as const


const SESSION_SCOPE_DESCRIPTIONS: Record<string, string> = {
  single: 'One session, one admin \u2014 most restrictive',
  shared: 'One shared session across all chats',
  per_chat: 'Separate session per conversation \u2014 recommended',
}

/* tabStyle removed — using .c-tab CSS class */

/** Generate a sensible default system prompt based on instance type. */
function transportChannel(transport: unknown): string {
  if (transport === 'twilio') return 'SMS'
  if (transport === 'signal') return 'Signal'
  if (transport === 'imessage') return 'iMessage'
  return 'WhatsApp'
}

function defaultSystemPrompt(name: string, type: string, transport: unknown): string {
  const titleName = name.charAt(0).toUpperCase() + name.slice(1)
  const channel = transportChannel(transport)
  if (type === 'agent') {
    return `You are ${titleName}, a helpful AI agent on ${channel}. You have access to tools including file operations, web search, and code execution within your sandbox. Keep responses concise — they're delivered as ${channel} messages. Ask clarifying questions when a request is ambiguous. Be direct, helpful, and personable.`
  }
  return `You are ${titleName}, a helpful AI assistant on ${channel}. You respond to messages in a conversational, friendly tone. Keep responses concise and relevant — they're delivered as ${channel} messages. If you don't know something, say so rather than guessing.`
}

/** Generate a sensible default CLAUDE.md for a new agent instance. */
function defaultClaudeMd(name: string, cwd: string, transport: unknown): string {
  const titleName = name.charAt(0).toUpperCase() + name.slice(1)
  const workspace = cwd.trim() || defaultAgentWorkspacePath(name)
  const channel = transportChannel(transport)
  return `# ${titleName} — ${channel} Agent

You are ${titleName}, an AI agent running on ${channel} via WhatSoup.

## Identity
- You are a helpful, direct assistant reachable over ${channel}
- You run as a Claude Code agent with tool access within your sandbox

## Workspace
- Your working directory is \`${workspace}\`
- You can create files, folders, and projects here freely
- Stay within this directory for all file operations

## Guardrails

### Stay in your lane
- Do NOT modify files outside your workspace
- Do NOT modify system configs, credentials, or infrastructure
- Do NOT restart, stop, or modify other WhatSoup instances

### Be conservative with resources
- Keep responses concise — they're delivered via ${channel}
- Don't spawn unnecessary background processes
- Don't install system-level packages without explicit permission

## Capabilities
- Web search and research
- Create and edit documents, code, and scripts
- Read and analyze files sent to you
- Help with planning, writing, and brainstorming
`
}

const DEFAULT_PROMPT_TRANSPORTS = ['baileys', 'twilio', 'signal', 'imessage'] as const

function generatedNameFromTitle(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1)
}

function isGeneratedSystemPrompt(value: string): boolean {
  const match = /^You are ([^,]+), a helpful AI (agent|assistant) on (?:WhatsApp|SMS|Signal|iMessage)\./.exec(value)
  if (!match) return false
  const generatedName = generatedNameFromTitle(match[1])
  const generatedType = match[2] === 'agent' ? 'agent' : 'chat'
  return DEFAULT_PROMPT_TRANSPORTS.some((transport) => (
    value === defaultSystemPrompt(generatedName, generatedType, transport)
  ))
}

function isGeneratedClaudeMd(value: string): boolean {
  const titleMatch = /^# (.+) — (?:WhatsApp|SMS|Signal|iMessage) Agent\n/.exec(value)
  const workspaceMatch = /\n- Your working directory is `([^`]+)`\n/.exec(value)
  if (!titleMatch || !workspaceMatch) return false
  const generatedName = generatedNameFromTitle(titleMatch[1])
  return DEFAULT_PROMPT_TRANSPORTS.some(
    (transport) => value === defaultClaudeMd(generatedName, workspaceMatch[1], transport),
  )
}

const ConfigStep: FC<ConfigStepProps> = ({ data, onChange, errors, onSkip }) => {
  const type = (data.type as string) ?? 'chat'
  const interactiveTwilio = data.transport === 'twilio' && type !== 'passive'
  const configuredAccessMode = (data.accessMode as string) ?? 'self_only'
  const accessMode = interactiveTwilio
    && (configuredAccessMode === 'self_only' || configuredAccessMode === 'groups_only')
    ? 'allowlist'
    : configuredAccessMode
  const accessOptions = interactiveTwilio
    ? ACCESS_OPTIONS.filter(({ value }) => value === 'allowlist' || value === 'open_dm')
    : ACCESS_OPTIONS
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
  const defaultWorkspace = defaultAgentWorkspacePath(name)

  // Fill blanks and replace only recognized generated defaults when identity or
  // transport changes. User-authored instructions are never rewritten.
  const initializedDefaults = useRef(false)
  useEffect(() => {
    const initializeBlankFields = !initializedDefaults.current
    initializedDefaults.current = true
    const patch: Record<string, unknown> = {}
    const nextSystemPrompt = defaultSystemPrompt(name, type, data.transport)
    if (
      type !== 'passive'
      && ((initializeBlankFields && !systemPrompt.trim()) || (
        systemPrompt !== nextSystemPrompt
        && isGeneratedSystemPrompt(systemPrompt)
      ))
    ) {
      patch.systemPrompt = nextSystemPrompt
    }
    const cwd = agentOptions.cwd ?? ''
    const nextClaudeMd = defaultClaudeMd(name, cwd, data.transport)
    if (
      type === 'agent'
      && ((initializeBlankFields && !claudeMd.trim()) || (
        claudeMd !== nextClaudeMd
        && isGeneratedClaudeMd(claudeMd)
      ))
    ) {
      patch.claudeMd = nextClaudeMd
    }
    if (Object.keys(patch).length > 0) onChange(patch)
  }, [agentOptions.cwd, claudeMd, data.transport, name, onChange, systemPrompt, type])

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
      const normalized = (value === undefined || value === '') ? undefined : value
      if (agentOptions.providerConfig?.[key] === normalized) return
      const current = { ...(agentOptions.providerConfig ?? {}) }
      if (normalized === undefined) {
        delete current[key]
      } else {
        current[key] = normalized
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
      if (newProvider === (agentOptions.provider ?? DEFAULT_PROVIDER_ID)) return
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

  const providerConfigFields = useMemo(
    () => getProviderConfigFields(agentOptions.provider ?? DEFAULT_PROVIDER_ID),
    [agentOptions.provider],
  )

  // Fallback provider/model — optional secondary backend the runtime switches to
  // when the primary hits a usage limit. Empty values are removed so they never
  // serialize as blank strings into agentOptions.
  const handleFallbackOption = useCallback(
    (key: 'fallbackProvider' | 'fallbackModel', value: string) => {
      const normalized = value === '' ? undefined : value
      if ((agentOptions[key] ?? undefined) === normalized) return
      const next = { ...agentOptions }
      if (normalized === undefined) {
        delete next[key]
      } else {
        next[key] = normalized
      }
      onChange({ agentOptions: next })
    },
    [agentOptions, onChange],
  )

  const clearFallbackOptions = useCallback(() => {
    const next = { ...agentOptions }
    delete next.fallbackProvider
    delete next.fallbackModel
    onChange({ agentOptions: next })
  }, [agentOptions, onChange])

  const handleFallbackProvider = useCallback(
    (value: string) => {
      if (value === '') {
        clearFallbackOptions()
        return
      }
      handleFallbackOption('fallbackProvider', value)
    },
    [clearFallbackOptions, handleFallbackOption],
  )

  const fallbackConfigured = (agentOptions.fallbackProvider ?? '') !== '' || (agentOptions.fallbackModel ?? '') !== ''
  const [fallbackSectionEnabled, setFallbackSectionEnabled] = useState<boolean>(fallbackConfigured)
  const fallbackEnabled = fallbackSectionEnabled || fallbackConfigured
  const fallbackProviderSelected = (agentOptions.fallbackProvider ?? '') !== ''

  const [activeTab, setActiveTab] = useState<string>('access')



  return (
    <div className="flex flex-col gap-[var(--sp-4)]">
      {/* Tab bar — Tabs primitive: roving tabindex, Arrow/Home/End, MANUAL activation. */}
      <Tabs label="Config sections" value={activeTab} onChange={setActiveTab}>
        <Tab id="access">Access</Tab>
        <Tab id="behavior">Behavior</Tab>
        {type === 'agent' && (
          <Tab id="permissions">Permissions</Tab>
        )}
        <Tab id="limits">Limits</Tab>
        <Tab id="rag">RAG <span className="text-text-3 text-xs">(optional)</span></Tab>
      </Tabs>

      {/* 1. Access — conditional-mount panel (Tabs.tsx header §11-13 sanctions this). */}
      {activeTab === 'access' && (
        <div role="tabpanel" id="tabpanel-access" aria-labelledby="tab-access" className="flex flex-col gap-[var(--sp-4)]">
          {interactiveTwilio && (
            <div className="bg-surface-raised rounded-md p-[var(--sp-4)]">
              <span className="c-heading text-s-warn">Twilio SMS identity limits</span>
              <p className="c-body text-text-2">Twilio SMS cannot authenticate sender identity, and SMS has no group chats. Admin Only and Groups Only are unavailable.</p>
            </div>
          )}
          <div>
            <label className="c-label c-field-label">
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                Access Mode
                <Check size={14} className="flex-none" style={{ color: 'var(--wizard-accent)' }} />
              </span>
            </label>
            <CardSelector
              label="Access Mode"
              options={accessOptions}
              selected={accessMode}
              onChange={(value) => onChange({ accessMode: value })}
            />
          </div>

          {accessMode === 'self_only' && (
            <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-3)]">
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Admin Only</span>
              <p className="c-body text-text-2">Only phone numbers listed as admin can interact with this line. All other messages are silently ignored. This is the most restrictive and secure setting.</p>
            </div>
          )}

          {accessMode === 'allowlist' && (
            <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-3)]">
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Allowlist</span>
              <p className="c-body text-text-2">
                {interactiveTwilio
                  ? 'New SMS contacts remain pending until an operator approves or blocks them in the console.'
                  : 'Only approved contacts can interact. New contacts will be held in a pending queue until an admin approves or blocks them.'}
              </p>
            </div>
          )}

          {accessMode === 'open_dm' && (
            <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-3)]">
              <span className="c-heading text-s-warn">Open DMs — Use Caution</span>
              <p className="c-body text-text-2">Anyone can send a direct message and the agent will respond. The agent has access to its configured tools and workspace. Only use this if you trust all potential contacts or have strict sandbox restrictions in the Permissions tab.</p>
            </div>
          )}

          {accessMode === 'groups_only' && (
            <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-3)]">
              <span className="c-heading" style={{ color: 'var(--wizard-accent)' }}>Groups Only</span>
              <p className="c-body text-text-2">This line only responds in group chats when mentioned. Direct messages are ignored. Useful for shared team bots.</p>
            </div>
          )}
        </div>
      )}

      {/* 2. Behavior */}
      {activeTab === 'behavior' && (
        <div role="tabpanel" id="tabpanel-behavior" aria-labelledby="tab-behavior" className="flex flex-col gap-[var(--sp-4)]">
          {/* System Prompt — hidden for passive lines */}
          {type !== 'passive' && (
            <Field label="System Prompt" error={errors.systemPrompt} confirmed={!errors.systemPrompt && systemPrompt.trim().length > 0}>
              {(id) => (
                <TextArea
                  id={id}
                  value={systemPrompt}
                  onChange={(e) => onChange({ systemPrompt: e.target.value })}
                  placeholder="You are a helpful assistant..."
                  error={!!errors.systemPrompt}
                  confirmed={!errors.systemPrompt && systemPrompt.trim().length > 0}
                  minHeight={120}
                />
              )}
            </Field>
          )}

          {/* CLAUDE.md */}
          <div>
            <label className="c-label c-field-label">
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                CLAUDE.md Instructions
                {claudeMd.trim().length > 0 && (
                  <Check size={14} className="flex-none" style={{ color: 'var(--wizard-accent)' }} />
                )}
              </span>
            </label>
            <div className="flex items-center justify-center cursor-pointer rounded-sm p-[var(--sp-4)] bg-surface-raised mb-[var(--sp-2)] c-border-dashed">
              <FileInput
                accept=".md,.txt"
                onChange={handleFileUpload}
                className="w-full cursor-pointer text-text-2"
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
        <div role="tabpanel" id="tabpanel-permissions" aria-labelledby="tab-permissions" className="flex flex-col gap-[var(--sp-4)]">
          <Field label="Working Directory" error={errors.cwd} helper="Directory will be created if it doesn't exist" confirmed={!errors.cwd && (agentOptions.cwd ?? defaultWorkspace).trim().length > 0}>
            {(id) => (
              <TextInput
                id={id}
                value={agentOptions.cwd ?? defaultWorkspace}
                onChange={(e) => handleAgentOption('cwd', e.target.value)}
                placeholder={defaultWorkspace}
                error={!!errors.cwd}
                confirmed={!errors.cwd && (agentOptions.cwd ?? defaultWorkspace).trim().length > 0}
              />
            )}
          </Field>
          <Field label="Session Scope" helper={SESSION_SCOPE_DESCRIPTIONS[agentOptions.sessionScope ?? 'per_chat']} confirmed>
            {(id) => (
              <SelectInput
                id={id}
                value={agentOptions.sessionScope ?? 'per_chat'}
                onChange={(e) => handleAgentOption('sessionScope', e.target.value)}
                confirmed
              >
                <option value="single">single</option>
                <option value="shared">shared</option>
                <option value="per_chat">per_chat</option>
              </SelectInput>
            )}
          </Field>

          <Field label="Provider" helper="AI backend for this agent instance" confirmed>
            {(id) => (
              <SelectInput
                id={id}
                value={agentOptions.provider ?? DEFAULT_PROVIDER_ID}
                onChange={(e) => handleProviderChange(e.target.value)}
                confirmed
              >
                {PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </SelectInput>
            )}
          </Field>

          {providerConfigFields.map(field => {
            const fieldValue = agentOptions.providerConfig?.[field.key]
            const hasValue = fieldValue !== undefined && fieldValue !== ''
            return (
              <Field
                key={field.key}
                label={field.label}
                confirmed={hasValue}
              >
                {(id) => (field.inputType === 'number' ? (
                  <NumberInput
                    id={id}
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
                    id={id}
                    value={(fieldValue as string) ?? ''}
                    onChange={(e) => handleProviderConfigOption(field.key, e.target.value || undefined)}
                    placeholder={field.placeholder}
                    confirmed={hasValue}
                  />
                ))}
              </Field>
            )
          })}

          {/* Fallback provider — optional secondary backend on usage-limit */}
          <CheckboxField
            label="Configure a fallback provider"
            checked={fallbackEnabled}
            onChange={(v) => {
              setFallbackSectionEnabled(v)
              if (!v) clearFallbackOptions()
            }}
            helper="Switch to a backup provider when the primary hits a usage limit"
          />
          {fallbackEnabled && (
            <>
              <Field label="Fallback Provider" helper="Backup AI backend for this agent instance" confirmed={(agentOptions.fallbackProvider ?? '').length > 0}>
                {(id) => (
                  <SelectInput
                    id={id}
                    value={agentOptions.fallbackProvider ?? ''}
                    onChange={(e) => handleFallbackProvider(e.target.value)}
                    confirmed={(agentOptions.fallbackProvider ?? '').length > 0}
                  >
                    <option value="">Select fallback provider</option>
                    {PROVIDERS.map(p => (
                      <option key={p.id} value={p.id}>{p.displayName}</option>
                    ))}
                  </SelectInput>
                )}
              </Field>
              <Field label="Fallback Model" confirmed={fallbackProviderSelected && (agentOptions.fallbackModel ?? '').length > 0}>
                {(id) => (
                  <TextInput
                    id={id}
                    value={fallbackProviderSelected ? (agentOptions.fallbackModel ?? '') : ''}
                    onChange={(e) => {
                      if (fallbackProviderSelected) handleFallbackOption('fallbackModel', e.target.value)
                    }}
                    placeholder={fallbackProviderSelected ? 'claude-sonnet-4-6' : 'Select a fallback provider first'}
                    disabled={!fallbackProviderSelected}
                    confirmed={fallbackProviderSelected && (agentOptions.fallbackModel ?? '').length > 0}
                  />
                )}
              </Field>
            </>
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
              {(id) => (
                <TextInput
                  id={id}
                  value={agentOptions.perUserDirs?.basePath ?? 'users'}
                  onChange={(e) => handlePerUserDirs('basePath', e.target.value)}
                  placeholder="users"
                  confirmed={(agentOptions.perUserDirs?.basePath ?? 'users').trim().length > 0}
                />
              )}
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
          <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-2)]">
            <label className="c-label c-field-label">
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                Enabled Plugins
                {agentOptions.enabledPlugins && (
                  <Check size={14} className="flex-none" style={{ color: 'var(--wizard-accent)' }} />
                )}
              </span>
            </label>
            <div className="c-helper">
              Select which plugins this instance loads. Disabled plugins save context tokens. Heavy plugins like SDLC-OS add ~66K tokens to every session.
            </div>
            <div className="flex items-center gap-[var(--sp-2)] mt-[var(--sp-2)] mb-[var(--sp-1)]">
              {agentOptions.enabledPlugins && Object.keys(agentOptions.enabledPlugins).length > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleAgentOption('enabledPlugins', {})}
                >
                  Reset to global defaults
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const all: Record<string, boolean> = {}
                  ALL_PLUGINS.forEach(p => { all[p.key] = true })
                  handleAgentOption('enabledPlugins', all)
                }}
              >
                Enable all
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const core: Record<string, boolean> = {}
                  ALL_PLUGINS.forEach(p => { core[p.key] = p.category === 'core' })
                  handleAgentOption('enabledPlugins', core)
                }}
              >
                Core only
              </Button>
            </div>
            {(Object.entries(CATEGORY_LABELS) as [string, string][]).map(([cat, catLabel]) => {
              const plugins = ALL_PLUGINS.filter(p => p.category === cat)
              if (plugins.length === 0) return null
              return (
                <div key={cat} className="mt-[var(--sp-3)]">
                  <div className="text-text-2 uppercase tracking-[var(--tracking-wide)] mb-[var(--sp-1)] text-xs">
                    {catLabel}
                  </div>
                  {plugins.map(plugin => {
                    const current = agentOptions.enabledPlugins ?? {}
                    const isEnabled = current[plugin.key] ?? true // default: inherit (enabled)
                    return (
                      <CheckboxField
                        key={plugin.key}
                        checked={isEnabled}
                        onChange={(checked) => {
                          const updated = { ...current, [plugin.key]: checked }
                          handleAgentOption('enabledPlugins', updated)
                        }}
                        className="cursor-pointer py-[var(--sp-1)] px-0"
                        inputClassName="self-start mt-[var(--sp-0h)]"
                        labelClassName="flex-1 min-w-0"
                        label={(
                          <span className="block flex-1 min-w-0">
                            <span className={`${isEnabled ? 'text-text-1' : 'text-text-2'} text-data block`}>
                              {plugin.label}
                            </span>
                            {' '}
                            <span className="text-text-3 text-xs block">
                              {plugin.description}
                            </span>
                          </span>
                        )}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* Settings JSON — permissions for Claude Code */}
          <div className="bg-surface-raised rounded-md p-[var(--sp-4)] mt-[var(--sp-2)]">
            <label className="c-label c-field-label">
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                Claude Code Permissions (settings.json)
                {(data.settingsJson as Record<string, unknown> | undefined) && (
                  <Check size={14} className="flex-none" style={{ color: 'var(--wizard-accent)' }} />
                )}
              </span>
            </label>
            <div className="c-helper">
              Controls which tools Claude Code is allowed to use. Default grants full bypass with standard MCP wildcards.
            </div>
            <Field label="Template" confirmed>
              {(id) => (
                <SelectInput
                  id={id}
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
              )}
            </Field>
            {(data.settingsJsonMode as string) === 'custom' && (
              <>
                <div className="mt-[var(--sp-2)]">
                  <FileInput
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
                    className="w-full cursor-pointer text-text-2 mb-[var(--sp-2)]"
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
        <div role="tabpanel" id="tabpanel-limits" aria-labelledby="tab-limits" className="flex flex-col gap-[var(--sp-4)]">
          <Field label="Messages per hour" confirmed>
            {(id) => (
              <NumberInput
                id={id}
                value={rateLimitPerHour}
                onChange={(e) => onChange({ rateLimitPerHour: Number(e.target.value) })}
                min={1}
                confirmed
              />
            )}
          </Field>
          <Field label="Max tokens per response" confirmed>
            {(id) => (
              <NumberInput
                id={id}
                value={maxTokens}
                onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
                min={1}
                confirmed
              />
            )}
          </Field>
          <Field label="Token budget per session" confirmed>
            {(id) => (
              <NumberInput
                id={id}
                value={tokenBudget}
                onChange={(e) => onChange({ tokenBudget: Number(e.target.value) })}
                min={1}
                confirmed
              />
            )}
          </Field>

          {/* Tool update verbosity */}
          <Field label="Tool update verbosity" helper="Minimal suppresses technical agent lifecycle messages" confirmed>
            {(id) => (
              <SelectInput
                id={id}
                value={toolUpdateMode}
                onChange={(e) => onChange({ toolUpdateMode: e.target.value })}
                confirmed
              >
                <option value="full">Full</option>
                <option value="minimal">Minimal</option>
              </SelectInput>
            )}
          </Field>
        </div>
      )}

      {/* 5. RAG */}
      {activeTab === 'rag' && (
        <div role="tabpanel" id="tabpanel-rag" aria-labelledby="tab-rag" className="flex flex-col gap-[var(--sp-4)]">
          <Field label="Pinecone Index Name" confirmed={pineconeIndex.trim().length > 0}>
            {(id) => (
              <TextInput
                id={id}
                value={pineconeIndex}
                onChange={(e) => onChange({ pineconeIndex: e.target.value })}
                placeholder="my-index"
                confirmed={pineconeIndex.trim().length > 0}
              />
            )}
          </Field>
          <div>
            <label className="c-label c-field-label">
              <span className="inline-flex items-center gap-[var(--sp-1)]">
                Search Mode
                <Check size={14} className="flex-none" style={{ color: 'var(--wizard-accent)' }} />
              </span>
            </label>
            <div className="flex">
              {SEARCH_MODES.map((mode) => (
                <Button
                  key={mode}
                  variant="neutral"
                  className="cursor-pointer py-[var(--sp-2)] px-[var(--sp-4)] text-data"
                  onClick={() => onChange({ pineconeSearchMode: mode })}
                  style={{
                    background:
                      pineconeSearchMode === mode ? 'var(--wizard-accent)' : 'var(--surface-raised)',
                    color:
                      pineconeSearchMode === mode ? 'var(--surface-base)' : 'var(--text-2)',
                    borderRadius:
                      mode === 'Memory'
                        ? 'var(--radius-sm) 0 0 var(--radius-sm)'
                        : '0 var(--radius-sm) var(--radius-sm) 0',
                    transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
                  }}
                >
                  {mode}
                </Button>
              ))}
            </div>
          </div>
          <CheckboxField
            label="Rerank results"
            checked={pineconeRerank}
            onChange={(v) => onChange({ pineconeRerank: v })}
          />
            <Field label="TopK" confirmed>
              {(id) => (
                <NumberInput
                  id={id}
                  value={pineconeTopK}
                  onChange={(e) => onChange({ pineconeTopK: Number(e.target.value) })}
                  min={1}
                  confirmed
                />
              )}
            </Field>
            <Field label="Allowed indexes" helper="Restrict which Pinecone indexes this instance can query" confirmed={pineconeAllowedIndexes.length > 0}>
              {(id) => (
                <TagInput
                  id={id}
                  values={pineconeAllowedIndexes}
                  onChange={(values) => onChange({ pineconeAllowedIndexes: values })}
                  placeholder="Index name"
                  accentColor={pineconeAllowedIndexes.length > 0 ? 'var(--wizard-accent)' : undefined}
                />
              )}
            </Field>
        </div>
      )}
      {/* Skip — sticky at bottom, right-aligned */}
      {onSkip && (
        <div className="flex justify-end mt-[var(--sp-4)] pt-[var(--sp-3)] c-border-t">
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
          >
            Skip — Use Defaults
          </Button>
        </div>
      )}
    </div>
  )
}

export default ConfigStep
