import { type FC } from 'react'
import { Shield, ShieldAlert, ShieldOff, Lock, Cpu, Layers } from 'lucide-react'
import type { LineInstance } from '../types'

interface LineTagsProps {
  line: LineInstance
}

interface TagDef {
  label: string
  icon: typeof Shield
  color: string
  bg: string
}

function getAccessTag(accessMode: string): TagDef | null {
  switch (accessMode) {
    case 'allowAll':
    case 'open_dm':
      return { label: 'open', icon: ShieldOff, color: 'var(--color-s-warn)', bg: 'var(--s-warn-wash)' }
    case 'allowList':
      return { label: 'allowlist', icon: Shield, color: 'var(--color-m-cht)', bg: 'var(--m-cht-wash)' }
    case 'denyAll':
      return { label: 'deny all', icon: ShieldAlert, color: 'var(--color-t4)', bg: 'var(--color-d4)' }
    default:
      return null
  }
}

function getModelTag(line: LineInstance): TagDef | null {
  const fallback = line.models?.fallback
  if (!fallback) return null
  const isOpenAi = fallback.toLowerCase().includes('gpt') || fallback.toLowerCase().includes('openai')
  if (!isOpenAi) return null
  return { label: 'openai fb', icon: Cpu, color: 'var(--color-s-warn)', bg: 'var(--s-warn-wash)' }
}

function getProviderTag(line: LineInstance): TagDef | null {
  if (line.mode !== 'agent') return null
  const provider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
  if (!provider || provider === 'claude-cli') return null
  return { label: provider, icon: Layers, color: 'var(--color-m-agt)', bg: 'var(--m-agt-wash)' }
}

const Tag: FC<{ tag: TagDef }> = ({ tag }) => {
  const Icon = tag.icon
  return (
    <span
      className="inline-flex items-center font-mono font-medium"
      style={{
        fontSize: 'var(--font-size-xs)',
        letterSpacing: 'var(--tracking-pill)',
        padding: '1px var(--sp-1h)',
        borderRadius: 'var(--radius-sm)',
        color: tag.color,
        backgroundColor: tag.bg,
        gap: '3px',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={9} strokeWidth={2} />
      {tag.label}
    </span>
  )
}

const LineTags: FC<LineTagsProps> = ({ line }) => {
  const tags: TagDef[] = []

  // Sandbox badge (agent lines only)
  if (line.mode === 'agent' && line.sandboxPerChat) {
    tags.push({ label: 'sandbox', icon: Lock, color: 'var(--color-m-agt)', bg: 'var(--m-agt-wash)' })
  }

  // Access mode
  const accessTag = getAccessTag(line.accessMode)
  if (accessTag) tags.push(accessTag)

  // OpenAI fallback
  const modelTag = getModelTag(line)
  if (modelTag) tags.push(modelTag)

  // Provider badge (agent lines with non-default provider)
  const providerTag = getProviderTag(line)
  if (providerTag) tags.push(providerTag)

  if (tags.length === 0) return null

  return (
    <div className="flex flex-wrap items-center" style={{ gap: '3px' }}>
      {tags.map(tag => <Tag key={tag.label} tag={tag} />)}
    </div>
  )
}

export default LineTags
