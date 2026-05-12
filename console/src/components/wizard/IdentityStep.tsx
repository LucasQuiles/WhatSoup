import { type FC, useEffect, useRef, useState } from 'react'
import { Bot, Check, Eye, Loader2, MessageSquare, X } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { api } from '../../lib/api'
import { slugAgentWorkspaceName } from '../../lib/agent-cwd.ts'
import { validatePhone } from '../../lib/validation'

interface IdentityStepProps {
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
  errors: Record<string, string>
  /** When true, the name field is locked because the instance was already created. */
  nameLocked?: boolean
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

type NameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error'

const IdentityStep: FC<IdentityStepProps> = ({ data, onChange, errors, nameLocked }) => {
  const [nameStatus, setNameStatus] = useState<NameStatus>('idle')
  const [showConfirmed, setShowConfirmed] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Delay all confirmation indicators on mount so they animate in together
  useEffect(() => {
    const timer = setTimeout(() => setShowConfirmed(true), 300)
    return () => clearTimeout(timer)
  }, [])

  const name = (data.name as string) ?? ''
  const description = (data.description as string) ?? ''
  const type = (data.type as string) ?? 'chat'
  const adminPhones = (data.adminPhones as string[]) ?? []

  /* Debounced uniqueness check */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()

    const slug = slugAgentWorkspaceName(name)

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
    <div className="flex flex-col gap-[var(--sp-4)]">
      {/* Type — first so it drives the rest of the wizard */}
      <div>
        <label className="c-heading c-field-label">
          Type
        </label>
        <CardSelector
          options={TYPE_OPTIONS}
          selected={type}
          onChange={(value) => onChange({ type: value })}
        />
        {errors.type && <div className="c-error">{errors.type}</div>}
      </div>

      {/* Name */}
      <div>
        <label className="c-heading c-field-label">
          Name
        </label>
        <div className="flex items-center gap-[var(--sp-2)]">
          <input
            type="text"
            value={name}
            onChange={(e) => onChange({ name: slugAgentWorkspaceName(e.target.value) })}
            placeholder="my-line"
            className={`c-input font-mono${nameLocked ? ' opacity-[var(--opacity-muted)] cursor-not-allowed' : ''}`}
            disabled={nameLocked}
            style={{
              borderColor: errors.name ? 'var(--color-s-crit)' : nameStatus === 'taken' ? 'var(--color-s-crit)' : nameStatus === 'available' || nameLocked ? 'var(--wizard-accent)' : 'var(--b2)',
            }}
          />
          {!nameLocked && nameStatus === 'checking' && (
            <Loader2 size={16} className="animate-spin text-t4 flex-none" />
          )}
          {(nameStatus === 'available' || nameLocked) && (
            <Check size={16} className="wizard-check" />
          )}
          {!nameLocked && nameStatus === 'taken' && (
            <X size={16} className="text-s-crit flex-none" />
          )}
        </div>
        {nameLocked && (
          <div className="c-helper">Name is locked — instance already provisioned</div>
        )}
        {!nameLocked && nameStatus === 'taken' && (
          <div className="c-error">Name already exists</div>
        )}
        {errors.name && (
          <div className="c-error">{errors.name}</div>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="c-heading c-field-label">
          Description <span className="text-t5">(optional)</span>
        </label>
        <div className="flex items-center gap-[var(--sp-2)]">
        <input
          type="text"
          value={description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What this line is for"
          className="c-input"
          style={{
            borderColor: showConfirmed && description.trim() ? 'var(--wizard-accent)' : 'var(--b2)',
          }}
        />
        {showConfirmed && description.trim() && (
          <Check size={16} className="wizard-check" />
        )}
        </div>
      </div>

      {/* Admin Phones */}
      <div>
        <label className="c-heading block mb-[var(--sp-1)]">Admin Phones</label>
        <div className="c-helper">{
          adminPhones.length === 0
            ? 'Phone numbers with full admin access to this line. Use international format without the +.'
            : adminPhones.length === 1
              ? 'Add another number for shared admin access, or continue with one.'
              : `${adminPhones.length} admin numbers configured.`
        }</div>
        <div className="flex items-start gap-[var(--sp-2)] mt-[var(--sp-2)]">
          <div className="flex-1 min-w-0">
            <TagInput
              values={adminPhones}
              onChange={(values) => onChange({ adminPhones: values.map(v => v.replace(/\D/g, '')) })}
              placeholder="Enter phone number"
              validate={validatePhone}
              accentColor={showConfirmed && adminPhones.length > 0 ? 'var(--wizard-accent)' : undefined}
            />
          </div>
          {showConfirmed && !errors.adminPhones && adminPhones.length > 0 && (
            <Check size={16} className="wizard-check mt-[var(--sp-2)]" />
          )}
        </div>
        {errors.adminPhones && <div className="c-error">{errors.adminPhones}</div>}
      </div>
    </div>
  )
}

export default IdentityStep
