import { type FC, type ChangeEvent, useCallback, useMemo } from 'react'
import { Lock, List, MessageCircle, Users } from 'lucide-react'
import CollapsibleSection from '../CollapsibleSection'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'

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

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-d1)',
  border: 'var(--bw) solid var(--b2)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--sp-2) var(--sp-3)',
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-t1)',
}

const numberInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 120,
  textAlign: 'right',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 'var(--sp-1)',
}

const helperStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--color-t4)',
  marginTop: 'var(--sp-1)',
}

const checkboxRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
}

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
              Access Mode
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
            <div>
              <label className="c-label" style={labelStyle}>
                System Prompt
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => onChange({ systemPrompt: e.target.value })}
                placeholder="You are a helpful assistant..."
                className="font-mono"
                style={{
                  ...inputStyle,
                  background: 'var(--color-d1)',
                  minHeight: 120,
                  resize: 'vertical',
                  borderColor: errors.systemPrompt ? 'var(--color-s-crit)' : undefined,
                }}
              />
              {errors.systemPrompt && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-s-crit)', marginTop: 'var(--sp-1)' }}>
                  {errors.systemPrompt}
                </div>
              )}
            </div>
          )}

          {/* CLAUDE.md */}
          <div>
            <label className="c-label" style={labelStyle}>
              CLAUDE.md Instructions
            </label>
            <div
              className="flex items-center justify-center cursor-pointer"
              style={{
                border: 'var(--bw) dashed var(--b2)',
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
            <textarea
              value={claudeMd}
              onChange={(e) => onChange({ claudeMd: e.target.value })}
              placeholder="Paste or edit CLAUDE.md contents..."
              className="font-mono"
              style={{
                ...inputStyle,
                minHeight: 120,
                resize: 'vertical',
              }}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* 3. Permissions — only for agent type */}
      {type === 'agent' && (
        <CollapsibleSection title="Permissions">
          <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
            <div>
              <label className="c-label" style={labelStyle}>
                Working Directory
              </label>
              <input
                type="text"
                value={agentOptions.cwd ?? ''}
                onChange={(e) => handleAgentOption('cwd', e.target.value)}
                placeholder="/home/q/LAB/your-project"
                className="font-mono"
                style={{
                  ...inputStyle,
                  borderColor: errors.cwd ? 'var(--color-s-crit)' : undefined,
                }}
              />
              {errors.cwd ? (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-s-crit)', marginTop: 'var(--sp-1)' }}>
                  {errors.cwd}
                </div>
              ) : (
                <div style={helperStyle}>
                  Directory will be created if it doesn&apos;t exist
                </div>
              )}
            </div>
            <div>
              <label className="c-label" style={labelStyle}>
                Session Scope
              </label>
              <select
                value={agentOptions.sessionScope ?? 'per_chat'}
                onChange={(e) => handleAgentOption('sessionScope', e.target.value)}
                style={inputStyle}
              >
                <option value="single">single</option>
                <option value="shared">shared</option>
                <option value="per_chat">per_chat</option>
              </select>
              <div style={helperStyle}>
                {SESSION_SCOPE_DESCRIPTIONS[agentOptions.sessionScope ?? 'per_chat']}
              </div>
            </div>

            {/* Sandbox per chat */}
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="sandboxPerChat"
                checked={agentOptions.sandboxPerChat ?? true}
                onChange={(e) => handleAgentOption('sandboxPerChat', e.target.checked)}
                style={{ accentColor: 'var(--color-s-ok)' }}
              />
              <label htmlFor="sandboxPerChat" className="c-label" style={{ cursor: 'pointer' }}>
                Isolate per-chat workspaces
              </label>
            </div>
            <div style={helperStyle}>
              Each conversation gets its own sandboxed directory
            </div>

            {/* Per-user directories */}
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="perUserDirsEnabled"
                checked={agentOptions.perUserDirs?.enabled ?? false}
                onChange={(e) => handlePerUserDirs('enabled', e.target.checked)}
                style={{ accentColor: 'var(--color-s-ok)' }}
              />
              <label htmlFor="perUserDirsEnabled" className="c-label" style={{ cursor: 'pointer' }}>
                Enable per-user directories
              </label>
            </div>
            {(agentOptions.perUserDirs?.enabled ?? false) && (
              <div>
                <label className="c-label" style={labelStyle}>
                  Base path
                </label>
                <input
                  type="text"
                  value={agentOptions.perUserDirs?.basePath ?? 'users'}
                  onChange={(e) => handlePerUserDirs('basePath', e.target.value)}
                  placeholder="users"
                  className="font-mono"
                  style={inputStyle}
                />
                <div style={helperStyle}>
                  Create separate workspace folders per contact
                </div>
              </div>
            )}

            {/* Bash enabled */}
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="bashEnabled"
                checked={agentOptions.sandbox?.bash?.enabled ?? true}
                onChange={(e) => handleSandboxBash('enabled', e.target.checked)}
                style={{ accentColor: 'var(--color-s-ok)' }}
              />
              <label htmlFor="bashEnabled" className="c-label" style={{ cursor: 'pointer' }}>
                Allow bash commands
              </label>
            </div>
            <div style={helperStyle}>
              Uncheck to completely disable shell access
            </div>

            {/* Bash path restriction */}
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="bashPathRestricted"
                checked={agentOptions.sandbox?.bash?.pathRestricted ?? true}
                onChange={(e) => handleSandboxBash('pathRestricted', e.target.checked)}
                style={{ accentColor: 'var(--color-s-ok)' }}
              />
              <label htmlFor="bashPathRestricted" className="c-label" style={{ cursor: 'pointer' }}>
                Restrict bash to allowed paths
              </label>
            </div>
            <div style={helperStyle}>
              Bash commands can only access files within the sandbox
            </div>

            {/* MCP send media */}
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="mcpSendMedia"
                checked={agentOptions.mcp?.send_media ?? true}
                onChange={(e) => handleMcpOption('send_media', e.target.checked)}
                style={{ accentColor: 'var(--color-s-ok)' }}
              />
              <label htmlFor="mcpSendMedia" className="c-label" style={{ cursor: 'pointer' }}>
                Allow sending media (images, files)
              </label>
            </div>
            <div style={helperStyle}>
              Enable the send_media MCP tool
            </div>
          </div>
        </CollapsibleSection>
      )}

      {/* 4. Limits */}
      <CollapsibleSection title="Limits">
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <div>
            <label className="c-label" style={labelStyle}>
              Messages per hour
            </label>
            <input
              type="number"
              value={rateLimitPerHour}
              onChange={(e) => onChange({ rateLimitPerHour: Number(e.target.value) })}
              min={1}
              style={numberInputStyle}
            />
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              Max tokens per response
            </label>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
              min={1}
              style={numberInputStyle}
            />
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              Token budget per session
            </label>
            <input
              type="number"
              value={tokenBudget}
              onChange={(e) => onChange({ tokenBudget: Number(e.target.value) })}
              min={1}
              style={numberInputStyle}
            />
          </div>

          {/* Tool update verbosity */}
          <div>
            <label className="c-label" style={labelStyle}>
              Tool update verbosity
            </label>
            <select
              value={toolUpdateMode}
              onChange={(e) => onChange({ toolUpdateMode: e.target.value })}
              style={inputStyle}
            >
              <option value="full">Full</option>
              <option value="minimal">Minimal</option>
            </select>
            <div style={helperStyle}>
              Minimal suppresses technical agent lifecycle messages
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* 5. RAG (optional) */}
      <CollapsibleSection title="RAG" badge="optional">
        <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
          <div>
            <label className="c-label" style={labelStyle}>
              Pinecone Index Name
            </label>
            <input
              type="text"
              value={pineconeIndex}
              onChange={(e) => onChange({ pineconeIndex: e.target.value })}
              placeholder="my-index"
              className="font-mono"
              style={inputStyle}
            />
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              Search Mode
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
                    border: 'var(--bw) solid var(--b2)',
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
          <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
            <input
              type="checkbox"
              id="pineconeRerank"
              checked={pineconeRerank}
              onChange={(e) => onChange({ pineconeRerank: e.target.checked })}
              style={{ accentColor: 'var(--color-s-ok)' }}
            />
            <label htmlFor="pineconeRerank" className="c-label" style={{ cursor: 'pointer' }}>
              Rerank results
            </label>
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              TopK
            </label>
            <input
              type="number"
              value={pineconeTopK}
              onChange={(e) => onChange({ pineconeTopK: Number(e.target.value) })}
              min={1}
              style={numberInputStyle}
            />
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              Allowed indexes
            </label>
            <TagInput
              values={pineconeAllowedIndexes}
              onChange={(values) => onChange({ pineconeAllowedIndexes: values })}
              placeholder="Index name"
            />
            <div style={helperStyle}>
              Restrict which Pinecone indexes this instance can query
            </div>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  )
}

export default ConfigStep
