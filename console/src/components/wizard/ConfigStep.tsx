import { type FC, type ChangeEvent, useCallback, useMemo } from 'react'
import { Lock, List, MessageCircle, Users } from 'lucide-react'
import CollapsibleSection from '../CollapsibleSection'
import CardSelector from '../CardSelector'

interface ConfigStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
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
  const agentOptions = useMemo(
    () => (data.agentOptions as { cwd?: string; sessionScope?: string }) ?? {},
    [data.agentOptions],
  )
  const rateLimit = (data.rateLimit as number) ?? 60
  const maxTokens = (data.maxTokens as number) ?? 4096
  const tokenBudget = (data.tokenBudget as number) ?? 50000
  const pineconeIndex = (data.pineconeIndex as string) ?? ''
  const searchMode = (data.searchMode as string) ?? 'Memory'
  const rerank = (data.rerank as boolean) ?? false
  const topK = (data.topK as number) ?? 20

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
    (key: string, value: string) => {
      onChange({ agentOptions: { ...agentOptions, [key]: value } })
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
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-t4)', marginTop: 'var(--sp-1)' }}>
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
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-t4)', marginTop: 'var(--sp-1)' }}>
                {SESSION_SCOPE_DESCRIPTIONS[agentOptions.sessionScope ?? 'per_chat']}
              </div>
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
              value={rateLimit}
              onChange={(e) => onChange({ rateLimit: Number(e.target.value) })}
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
                  onClick={() => onChange({ searchMode: mode })}
                  style={{
                    background:
                      searchMode === mode ? 'var(--color-s-ok)' : 'var(--color-d3)',
                    color:
                      searchMode === mode ? 'var(--color-d0)' : 'var(--color-t3)',
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
              id="rerank"
              checked={rerank}
              onChange={(e) => onChange({ rerank: e.target.checked })}
              style={{ accentColor: 'var(--color-s-ok)' }}
            />
            <label htmlFor="rerank" className="c-label" style={{ cursor: 'pointer' }}>
              Rerank results
            </label>
          </div>
          <div>
            <label className="c-label" style={labelStyle}>
              TopK
            </label>
            <input
              type="number"
              value={topK}
              onChange={(e) => onChange({ topK: Number(e.target.value) })}
              min={1}
              style={numberInputStyle}
            />
          </div>
        </div>
      </CollapsibleSection>
    </div>
  )
}

export default ConfigStep
