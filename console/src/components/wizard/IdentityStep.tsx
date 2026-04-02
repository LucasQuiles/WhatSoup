import { type FC, useEffect, useRef, useState } from 'react'
import { Bot, Check, Eye, Loader2, MessageSquare, X } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { api } from '../../lib/api'
import { errorStyle, helperStyle, labelStyle, inputStyle } from './form-styles'

interface IdentityStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
}

const TYPE_OPTIONS = [
  {
    value: 'passive',
    label: 'Passive',
    description: 'Listen & store messages. No AI responses.',
    icon: <Eye size={24} />,
    color: 'var(--color-m-pas)',
  },
  {
    value: 'chat',
    label: 'Chat',
    description: 'Conversational AI bot with API key.',
    icon: <MessageSquare size={24} />,
    color: 'var(--color-m-cht)',
  },
  {
    value: 'agent',
    label: 'Agent',
    description: 'Full Claude Code agent with tool access.',
    icon: <Bot size={24} />,
    color: 'var(--color-m-agt)',
  },
]

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

function validatePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

type NameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error'

const IdentityStep: FC<IdentityStepProps> = ({ data, onChange, errors }) => {
  const [nameStatus, setNameStatus] = useState<NameStatus>('idle')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const name = (data.name as string) ?? ''
  const description = (data.description as string) ?? ''
  const type = (data.type as string) ?? 'chat'
  const adminPhones = (data.adminPhones as string[]) ?? []

  /* Debounced uniqueness check */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()

    const slug = slugify(name)

    debounceRef.current = setTimeout(() => {
      if (!slug) {
        setNameStatus('idle')
        return
      }
      setNameStatus('checking')
      const controller = new AbortController()
      abortRef.current = controller
      api
        .checkExists(slug)
        .then((res) => {
          if (controller.signal.aborted) return
          setNameStatus(res.exists ? 'taken' : 'available')
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setNameStatus('error')
        })
    }, slug ? 500 : 0)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [name])

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
      {/* Type — first so it drives the rest of the wizard */}
      <div>
        <label className="c-heading" style={labelStyle}>
          Type
        </label>
        <CardSelector
          options={TYPE_OPTIONS}
          selected={type}
          onChange={(value) => onChange({ type: value })}
        />
        {errors.type && <div style={errorStyle}>{errors.type}</div>}
      </div>

      {/* Name */}
      <div>
        <label className="c-heading" style={labelStyle}>
          Name
        </label>
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          <input
            type="text"
            value={name}
            onChange={(e) => onChange({ name: slugify(e.target.value) })}
            placeholder="my-line"
            className="font-mono"
            style={{
              ...inputStyle,
              borderColor: errors.name ? 'var(--color-s-crit)' : nameStatus === 'taken' ? 'var(--color-s-crit)' : nameStatus === 'available' ? 'var(--wizard-accent)' : 'var(--b2)',
            }}
          />
          {nameStatus === 'checking' && (
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--color-t4)', flexShrink: 0 }} />
          )}
          {nameStatus === 'available' && (
            <Check size={16} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
          )}
          {nameStatus === 'taken' && (
            <X size={16} style={{ color: 'var(--color-s-crit)', flexShrink: 0 }} />
          )}
        </div>
        {nameStatus === 'taken' && (
          <div style={errorStyle}>Name already exists</div>
        )}
        {errors.name && (
          <div style={errorStyle}>{errors.name}</div>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="c-heading" style={labelStyle}>
          Description <span style={{ color: 'var(--color-t5)' }}>(optional)</span>
        </label>
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
        <input
          type="text"
          value={description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What this line is for"
          style={{
            ...inputStyle,
            borderColor: description.trim() ? 'var(--wizard-accent)' : 'var(--b2)',
          }}
        />
        {description.trim() && (
          <Check size={16} style={{ color: 'var(--wizard-accent)', flexShrink: 0 }} />
        )}
        </div>
      </div>

      {/* Admin Phones */}
      <div>
        <label className="c-heading" style={labelStyle}>Admin Phones</label>
        <div className="flex items-start" style={{ gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TagInput
              values={adminPhones}
              onChange={(values) => onChange({ adminPhones: values.map(v => v.replace(/\D/g, '')) })}
              placeholder="Enter phone number"
              validate={validatePhone}
              accentColor={adminPhones.length > 0 ? 'var(--wizard-accent)' : undefined}
            />
          </div>
          {!errors.adminPhones && adminPhones.length > 0 && (
            <Check size={16} style={{ color: 'var(--wizard-accent)', flexShrink: 0, marginTop: 'var(--sp-2)' }} />
          )}
        </div>
        {errors.adminPhones && <div style={errorStyle}>{errors.adminPhones}</div>}
        {!errors.adminPhones && <div style={helperStyle}>Phone numbers with full admin access to this line. Use international format without the +.</div>}
      </div>
    </div>
  )
}

export default IdentityStep
