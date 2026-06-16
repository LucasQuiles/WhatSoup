import { type FC, useEffect, useId, useRef, useState } from 'react'
import { Bot, Check, Eye, Loader2, MessageSquare, X } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { api } from '../../lib/api'
import { slugAgentWorkspaceName } from '../../lib/agent-cwd.ts'
import { validatePhone } from '../../lib/validation'
import { TextInput } from '../primitives'
import WizardStep from './WizardStep'

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
  const typeErrorId = useId()
  const nameInputId = useId()
  const nameLockedHelperId = useId()
  const nameTakenErrorId = useId()
  const nameErrorId = useId()
  const descriptionInputId = useId()
  const adminPhonesInputId = useId()
  const adminPhonesHelperId = useId()
  const adminPhonesErrorId = useId()
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
  const adminPhonesHelperText = adminPhones.length === 0
    ? 'Phone numbers with full admin access to this line. Use international format without the +.'
    : adminPhones.length === 1
      ? 'Add another number for shared admin access, or continue with one.'
      : `${adminPhones.length} admin numbers configured.`
  const adminPhonesDescribedBy = [
    adminPhonesHelperId,
    errors.adminPhones ? adminPhonesErrorId : undefined,
  ].filter(Boolean).join(' ')
  const hasNameTakenError = !nameLocked && nameStatus === 'taken'
  const nameDescribedBy = [
    nameLocked ? nameLockedHelperId : undefined,
    hasNameTakenError ? nameTakenErrorId : undefined,
    errors.name ? nameErrorId : undefined,
  ].filter(Boolean).join(' ') || undefined

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
    <WizardStep title="Identity" subtitle="Name this line and choose its type.">
      {/* Type — first so it drives the rest of the wizard */}
      <div>
        {/* Visual heading only — CardSelector's radiogroup carries its own
            accessible name ("Line Type"), so a bound <label> would be orphaned. */}
        <div className="c-heading c-field-label" aria-hidden="true">
          Type
        </div>
        <CardSelector
          label="Line Type"
          options={TYPE_OPTIONS}
          selected={type}
          onChange={(value) => onChange({ type: value })}
          aria-invalid={errors.type ? true : undefined}
          aria-describedby={errors.type ? typeErrorId : undefined}
        />
        {errors.type && <div id={typeErrorId} className="c-error">{errors.type}</div>}
      </div>

      {/* Name */}
      <div>
        <label htmlFor={nameInputId} className="c-heading c-field-label">
          Name
        </label>
        <div className="flex items-center gap-[var(--sp-2)]">
          <TextInput
            id={nameInputId}
            type="text"
            value={name}
            onChange={(e) => onChange({ name: slugAgentWorkspaceName(e.target.value) })}
            placeholder="my-line"
            className={nameLocked ? 'opacity-[var(--opacity-muted)] cursor-not-allowed' : ''}
            disabled={nameLocked}
            aria-invalid={errors.name || hasNameTakenError ? true : undefined}
            aria-describedby={nameDescribedBy}
            error={Boolean(errors.name) || hasNameTakenError}
            confirmed={nameStatus === 'available' || nameLocked}
          />
          {!nameLocked && nameStatus === 'checking' && (
            <Loader2 size={16} className="animate-spin text-text-2 flex-none" />
          )}
          {(nameStatus === 'available' || nameLocked) && (
            <Check size={16} className="wizard-check" />
          )}
          {!nameLocked && nameStatus === 'taken' && (
            <X size={16} className="text-s-crit flex-none" />
          )}
        </div>
        {nameLocked && (
          <div id={nameLockedHelperId} className="c-helper">Name is locked — instance already provisioned</div>
        )}
        {hasNameTakenError && (
          <div id={nameTakenErrorId} className="c-error">Name already exists</div>
        )}
        {errors.name && (
          <div id={nameErrorId} className="c-error">{errors.name}</div>
        )}
      </div>

      {/* Description */}
      <div>
        <label htmlFor={descriptionInputId} className="c-heading c-field-label">
          Description <span className="text-text-3">(optional)</span>
        </label>
        <div className="flex items-center gap-[var(--sp-2)]">
        <TextInput
          id={descriptionInputId}
          type="text"
          value={description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What this line is for"
          confirmed={showConfirmed && Boolean(description.trim())}
        />
        {showConfirmed && description.trim() && (
          <Check size={16} className="wizard-check" />
        )}
        </div>
      </div>

      {/* Admin Phones */}
      <div>
        <label htmlFor={adminPhonesInputId} className="c-heading block mb-[var(--sp-1)]">Admin Phones</label>
        <div id={adminPhonesHelperId} className="c-helper">{adminPhonesHelperText}</div>
        <div className="flex items-start gap-[var(--sp-2)] mt-[var(--sp-2)]">
          <div className="flex-1 min-w-0">
            <TagInput
              id={adminPhonesInputId}
              values={adminPhones}
              onChange={(values) => onChange({ adminPhones: values.map(v => v.replace(/\D/g, '')) })}
              placeholder="Enter phone number"
              validate={validatePhone}
              accentColor={showConfirmed && adminPhones.length > 0 ? 'var(--wizard-accent)' : undefined}
              aria-invalid={errors.adminPhones ? true : undefined}
              aria-describedby={adminPhonesDescribedBy}
            />
          </div>
          {showConfirmed && !errors.adminPhones && adminPhones.length > 0 && (
            <Check size={16} className="wizard-check mt-[var(--sp-2)]" />
          )}
        </div>
        {errors.adminPhones && <div id={adminPhonesErrorId} className="c-error">{errors.adminPhones}</div>}
      </div>
    </WizardStep>
  )
}

export default IdentityStep
