import { type FC } from 'react'
import { Pencil, AlertCircle } from 'lucide-react'
import ModeBadge from '../ModeBadge'
import TransportBadge from '../TransportBadge'
import { getProviderConfigFields, DEFAULT_PROVIDER_ID } from '../../lib/providers'
import { defaultAgentWorkspacePath } from '../../lib/agent-cwd'
import { ACCESS_MODE_LABELS } from '../../lib/access-modes'
import { formatCount } from '../../lib/text-utils'
import { Button } from '../primitives/Button'
import { isTransportKind, TRANSPORT_MAP, type TransportKind } from '../../lib/transport-meta'

interface ReviewStepProps {
  data: Record<string, unknown>
  onEditPhase: (phase: number) => void
  onCreateLine: () => Promise<void>
  creating: boolean
  error: string | null
}

/* ── Shared styles ── */

const cardStyle: React.CSSProperties = {
  background: 'var(--surface-inset)',
  borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--border-subtle)',
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
  letterSpacing: 'var(--tracking-label)',
  color: 'var(--text-2)',
}

const kvRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: 'var(--sp-1) 0',
}

const kvLabelStyle: React.CSSProperties = {
  color: 'var(--text-2)',
}

const kvValueStyle: React.CSSProperties = {
  color: 'var(--text-1)',
}

/* ── Edit button ── */

const EditBtn: FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button
    variant="ghost"
    className="flex items-center gap-[var(--sp-1)] py-[var(--sp-1)] px-[var(--sp-2)]"
    icon={<Pencil size={12} strokeWidth={1.75} />}
    onClick={onClick}
  >
    <span className="text-xs">Edit</span>
  </Button>
)

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—'
}

/* ── Key-value row ── */

const KV: FC<{ label: string; value: React.ReactNode; fullValue?: string }> = ({ label, value, fullValue }) => (
  <div style={kvRowStyle}>
    <span className="text-label" style={kvLabelStyle}>{label}</span>
    <span title={fullValue} className="font-mono text-data" style={kvValueStyle}>{value}</span>
  </div>
)

/* ── First-line preview helper ── */

function previewFirstLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? ''
  if (firstLine.length <= max) return firstLine
  return firstLine.slice(0, max) + '...'
}

/* ── Friendly error messages ── */

function friendlyError(raw: string, transport: TransportKind): string {
  if (raw.includes('already exists')) return 'An instance with this name already exists. Go back to Identity and choose a different name.'
  if (raw.includes('systemPrompt')) return 'A system prompt is required. Click "Edit" on the Config card above to add one.'
  if (raw.includes('agentOptions')) return 'Agent configuration is incomplete. Click "Edit" on the Config card to set a working directory.'
  if (raw.includes('adminPhones')) {
    return transport === 'twilio'
      ? 'At least one notification phone is required. Click "Edit" on the Identity card.'
      : `At least one ${TRANSPORT_MAP[transport].adminIdLabel.toLowerCase().replace(/^admin /, '')} is required. Click "Edit" on the Identity card.`
  }
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
  const transport: TransportKind = isTransportKind(data.transport) ? data.transport : 'baileys'
  const transportMeta = TRANSPORT_MAP[transport]
  const twilioConfig = record(data.twilioConfig)
  const signalConfig = record(data.signalConfig)
  const imessageConfig = record(data.imessageConfig)
  const adminPhones = (data.adminPhones as string[]) ?? []
  const models = data.models as Record<string, string> | undefined
  const authMethod = (data.authMethod as string) ?? 'api_key'
  const accessMode = (data.accessMode as string) ?? 'self_only'
  const systemPrompt = (data.systemPrompt as string) ?? ''
  const rateLimitPerHour = (data.rateLimitPerHour as number) ?? 60
  const tokenBudget = (data.tokenBudget as number) ?? 50000
  const agentOptions = (data.agentOptions as { cwd?: string; sessionScope?: string; provider?: string; providerConfig?: Record<string, unknown> }) ?? {}
  const pineconeIndex = (data.pineconeIndex as string) ?? ''
  const agentCwd = agentOptions.cwd || defaultAgentWorkspacePath(name)

  return (
    <div className="flex flex-col gap-[var(--sp-4)]">
      {/* Identity card */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span className="font-medium text-data" style={headingStyle}>Identity</span>
          <EditBtn onClick={() => onEditPhase(0)} />
        </div>
        <KV label="Name" value={name || '-'} />
        {description && <KV label="Description" value={description} />}
        <KV
          label="Type"
          value={<ModeBadge mode={type as 'passive' | 'chat' | 'agent'} />}
        />
        <KV label={transportMeta.adminIdLabel} value={`${adminPhones.length} configured`} />
      </div>

      <section style={cardStyle} aria-labelledby="review-transport-heading">
        <div style={cardHeaderStyle}>
          <span id="review-transport-heading" className="font-medium text-data" style={headingStyle}>Transport</span>
          <EditBtn onClick={() => onEditPhase(0)} />
        </div>
        <KV
          label="Kind"
          value={<TransportBadge kind={transport} backend={imessageConfig.backend as 'imsg' | 'bluebubbles' | undefined} />}
        />
        {transport === 'twilio' && (
          <>
            <KV label="Account SID" value={text(twilioConfig.accountSid)} />
            <KV label="Sender" value={text(twilioConfig.phoneNumber ?? twilioConfig.messagingServiceSid)} />
            <KV label="Auth token service" value={text(twilioConfig.authTokenService)} />
          </>
        )}
        {transport === 'signal' && (
          <>
            <KV label="Self number" value={text(signalConfig.phoneNumber)} />
            <KV label="Endpoint" value={signalConfig.socketPath
              ? text(signalConfig.socketPath)
              : `${text(signalConfig.tcpHost)}:${text(signalConfig.tcpPort)}`}
            />
          </>
        )}
        {transport === 'imessage' && (
          <>
            <KV label="Sender" value={text(imessageConfig.sender)} />
            <KV label="Backend" value={text(imessageConfig.backend)} />
            <KV label="Endpoint" value={text(imessageConfig.bluebubblesUrl ?? imessageConfig.imsgSocketPath)} />
            {imessageConfig.backend === 'bluebubbles' && (
              <KV label="Password service" value={text(imessageConfig.bluebubblesPasswordService)} />
            )}
          </>
        )}
      </section>

      {/* Model card */}
      <div style={cardStyle}>
        <div style={cardHeaderStyle}>
          <span className="font-medium text-data" style={headingStyle}>Model &amp; Auth</span>
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
          <span className="font-medium text-data" style={headingStyle}>Config</span>
          <EditBtn onClick={() => onEditPhase(3)} />
        </div>
        <KV label="Access mode" value={ACCESS_MODE_LABELS[accessMode as keyof typeof ACCESS_MODE_LABELS] ?? accessMode} />
        {type !== 'passive' && systemPrompt && (
          <KV label="System prompt" value={previewFirstLine(systemPrompt, 60)} fullValue={systemPrompt} />
        )}
        <KV label="Rate limit" value={`${rateLimitPerHour}/hr`} />
        <KV label="Token budget" value={formatCount(tokenBudget)} />
        {type === 'agent' && (
          <>
            <KV label="CWD" value={agentCwd} />
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
          className="flex items-center gap-[var(--sp-2)] p-[var(--sp-3)] bg-surface-raised rounded-sm"
          style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--color-s-crit)' }}
        >
          <AlertCircle size={16} className="text-s-crit flex-shrink-0" />
          <span className="text-s-crit text-data">
            {friendlyError(error, transport)}
          </span>
        </div>
      )}

      {/* Create button */}
      <Button
        variant="primary"
        className="flex items-center justify-center self-stretch gap-[var(--sp-2)] p-[var(--sp-3)]"
        onClick={onCreateLine}
        loading={creating}
      >
        {creating ? 'Creating...' : 'Create Line'}
      </Button>
    </div>
  )
}

export default ReviewStep
