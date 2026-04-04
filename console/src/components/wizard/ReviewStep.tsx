import { type FC } from 'react'
import { Pencil, Loader2, AlertCircle } from 'lucide-react'
import ModeBadge from '../ModeBadge'
import { getProviderConfigFields, DEFAULT_PROVIDER_ID } from '../../lib/providers'

interface ReviewStepProps {
  data: Record<string, unknown>
  onEditPhase: (phase: number) => void
  onCreateLine: () => Promise<void>
  creating: boolean
  error: string | null
}

/* ── Shared styles ── */

const cardStyle: React.CSSProperties = {
  background: 'var(--color-d1)',
  borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--sp-4)',
}

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 'var(--sp-3)',
}

const headingStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-data)',
  letterSpacing: 'var(--tracking-label)',
  color: 'var(--color-t2)',
}

const kvRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 'var(--sp-1) 0',
}

const kvLabelStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-label)',
  color: 'var(--color-t4)',
}

const kvValueStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-data)',
  color: 'var(--color-t1)',
}

/* ── Edit button ── */

const EditBtn: FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    className="c-btn c-btn-ghost flex items-center"
    style={{ gap: 'var(--sp-1)', padding: 'var(--sp-1) var(--sp-2)' }}
    onClick={onClick}
  >
    <Pencil size={12} />
    <span style={{ fontSize: 'var(--font-size-xs)' }}>Edit</span>
  </button>
)

/* ── Key-value row ── */

const KV: FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={kvRowStyle}>
    <span style={kvLabelStyle}>{label}</span>
    <span className="font-mono" style={kvValueStyle}>{value}</span>
  </div>
)

/* ── Truncate helper ── */

function truncate(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? ''
  if (firstLine.length <= max) return firstLine
  return firstLine.slice(0, max) + '...'
}

/* ── Friendly error messages ── */

function friendlyError(raw: string): string {
  if (raw.includes('already exists')) return 'An instance with this name already exists. Go back to Identity and choose a different name.'
  if (raw.includes('systemPrompt')) return 'A system prompt is required. Click "Edit" on the Config card above to add one.'
  if (raw.includes('agentOptions')) return 'Agent configuration is incomplete. Click "Edit" on the Config card to set a working directory.'
  if (raw.includes('adminPhones')) return 'At least one admin phone number is required. Click "Edit" on the Identity card.'
  if (raw.includes('cwd must be within')) return 'The working directory must be inside the home directory. Click "Edit" on the Config card to fix.'
  if (raw.includes('rateLimitPerHour')) return 'Rate limit must be between 1 and 10,000 per hour. Click "Edit" on the Config card.'
  if (raw.includes('maxTokens')) return 'Max tokens must be between 256 and 200,000. Click "Edit" on the Config card.'
  if (raw.includes('tokenBudget')) return 'Token budget must be between 1,000 and 10,000,000. Click "Edit" on the Config card.'
  if (raw.includes('timeout') || raw.includes('AbortError')) return 'The request timed out. The fleet server may be under heavy load — try again.'
  if (raw.includes('fetch') || raw.includes('network')) return 'Could not reach the fleet server. Check that it is running and try again.'
  return `Something went wrong: ${raw}`
}

/* ── Main component ── */

const ReviewStep: FC<ReviewStepProps> = ({
  data,
  onEditPhase,
  onCreateLine,
  creating,
  error,
}) => {
  const name = (data.name as string) ?? ''
  const description = (data.description as string) ?? ''
  const type = (data.type as string) ?? 'chat'
  const adminPhones = (data.adminPhones as string[]) ?? []
  const models = data.models as Record<string, string> | undefined
  const authMethod = (data.authMethod as string) ?? 'api_key'
  const accessMode = (data.accessMode as string) ?? 'self_only'
  const systemPrompt = (data.systemPrompt as string) ?? ''
  const rateLimitPerHour = (data.rateLimitPerHour as number) ?? 60
  const tokenBudget = (data.tokenBudget as number) ?? 50000
  const agentOptions = (data.agentOptions as { cwd?: string; sessionScope?: string; provider?: string; providerConfig?: Record<string, unknown> }) ?? {}
  const pineconeIndex = (data.pineconeIndex as string) ?? ''

  const accessLabels: Record<string, string> = {
    self_only: 'Admin Only',
    allowlist: 'Allowlist',
    open_dm: 'Open DMs',
    groups_only: 'Groups Only',
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      {/* Identity card */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span className="font-medium" style={headingStyle}>Identity</span>
          <EditBtn onClick={() => onEditPhase(0)} />
        </div>
        <KV label="Name" value={name || '-'} />
        {description && <KV label="Description" value={description} />}
        <KV
          label="Type"
          value={<ModeBadge mode={type as 'passive' | 'chat' | 'agent'} />}
        />
        <KV label="Admin phones" value={`${adminPhones.length} configured`} />
      </div>

      {/* Model card */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span className="font-medium" style={headingStyle}>Model &amp; Auth</span>
          <EditBtn onClick={() => onEditPhase(2)} />
        </div>
        {type === 'passive' ? (
          <KV label="Models" value="None (passive)" />
        ) : (
          <>
            <KV
              label="Conversation"
              value={models?.conversation ?? 'claude-sonnet-4-6'}
            />
            <KV
              label="Extraction"
              value={models?.extraction ?? 'claude-haiku-4-5-20251001'}
            />
            <KV
              label="Auth"
              value={authMethod === 'oauth' ? 'OAuth session' : 'API key'}
            />
          </>
        )}
      </div>

      {/* Config card */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span className="font-medium" style={headingStyle}>Config</span>
          <EditBtn onClick={() => onEditPhase(3)} />
        </div>
        <KV label="Access mode" value={accessLabels[accessMode] ?? accessMode} />
        {type !== 'passive' && systemPrompt && (
          <KV label="System prompt" value={truncate(systemPrompt, 60)} />
        )}
        <KV label="Rate limit" value={`${rateLimitPerHour}/hr`} />
        <KV label="Token budget" value={tokenBudget.toLocaleString()} />
        {type === 'agent' && (
          <>
            <KV label="CWD" value={agentOptions.cwd || 'Not set'} />
            <KV label="Session scope" value={agentOptions.sessionScope ?? 'single'} />
            <KV label="Provider" value={agentOptions.provider ?? DEFAULT_PROVIDER_ID} />
            {agentOptions.provider && agentOptions.provider !== DEFAULT_PROVIDER_ID &&
              getProviderConfigFields(agentOptions.provider).map(field => {
                const v = agentOptions.providerConfig?.[field.key]
                return v != null && v !== ''
                  ? <KV key={field.key} label={field.label} value={String(v)} />
                  : null
              })
            }
          </>
        )}
        <KV
          label="RAG"
          value={pineconeIndex || 'Not configured'}
        />
      </div>

      {/* Error message */}
      {error && (
        <div
          className="flex items-center"
          style={{
            gap: 'var(--sp-2)',
            padding: 'var(--sp-3)',
            background: 'var(--color-d3)',
            borderRadius: 'var(--radius-sm)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--color-s-crit)',
          }}
        >
          <AlertCircle size={16} style={{ color: 'var(--color-s-crit)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-s-crit)' }}>
            {friendlyError(error)}
          </span>
        </div>
      )}

      {/* Create button */}
      <button
        type="button"
        className="c-btn c-btn-primary flex items-center justify-center self-stretch"
        style={{ gap: 'var(--sp-2)', padding: 'var(--sp-3)' }}
        onClick={onCreateLine}
        disabled={creating}
      >
        {creating && <Loader2 size={16} className="animate-spin" />}
        {creating ? 'Creating...' : 'Create Line'}
      </button>
    </div>
  )
}

export default ReviewStep
