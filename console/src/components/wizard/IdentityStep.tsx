import { type FC, useEffect, useId, useRef, useState } from 'react'
import { Bot, Check, Eye, Loader2, MessageSquare, X } from 'lucide-react'
import CardSelector from '../CardSelector'
import TagInput from '../TagInput'
import { api } from '../../lib/api'
import { slugAgentWorkspaceName } from '../../lib/agent-cwd.ts'
import { validatePhone } from '../../lib/validation'
import { Field, TextInput } from '../primitives'
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
  const hasNameTakenError = !nameLocked && nameStatus === 'taken'
  // Name error-priority (owner round-5 dec 3): nameLocked → helper; else nameTaken → error;
  // else errors.name → error. Field renders one helper OR one error, so we resolve here.
  const nameErrorMsg = nameLocked
    ? undefined
    : hasNameTakenError
      ? 'Name already exists'
      : errors.name || undefined
  const nameHelperMsg = nameLocked ? 'Name is locked — instance already provisioned' : undefined

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

      {/* Name — canonical Field; the tri-state availability indicator rides the
          statusAdornment slot (Loader2 / Check / X), error+helper resolved by priority (W2-S5). */}
      <Field
        label="Name"
        error={nameErrorMsg}
        helper={nameHelperMsg}
        statusAdornment={
          !nameLocked && nameStatus === 'checking' ? (
            <Loader2 size={16} className="animate-spin text-text-2 flex-none" />
          ) : nameStatus === 'available' || nameLocked ? (
            <Check size={16} className="wizard-check" />
          ) : !nameLocked && nameStatus === 'taken' ? (
            <X size={16} className="text-s-crit flex-none" />
          ) : null
        }
      >
        {(id) => (
          <TextInput
            id={id}
            type="text"
            value={name}
            onChange={(e) => onChange({ name: slugAgentWorkspaceName(e.target.value) })}
            placeholder="my-line"
            className={nameLocked ? 'opacity-[var(--opacity-muted)] cursor-not-allowed' : ''}
            disabled={nameLocked}
            error={Boolean(nameErrorMsg)}
          />
        )}
      </Field>

      {/* Description — canonical Field: optional marker + built-in confirmed Check (DD-43/W2-S5) */}
      <Field label="Description" optional confirmed={showConfirmed && Boolean(description.trim())}>
        {(id) => (
          <TextInput
            id={id}
            type="text"
            value={description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="What this line is for"
            confirmed={showConfirmed && Boolean(description.trim())}
          />
        )}
      </Field>

      {/* Admin Phones — canonical Field; helper moves BELOW the control per input.md
          ([label][control][hint|error]) and the built-in confirmed Check replaces the manual one (W2-S5). */}
      <Field
        label="Admin Phones"
        helper={adminPhonesHelperText}
        error={errors.adminPhones || undefined}
        confirmed={showConfirmed && !errors.adminPhones && adminPhones.length > 0}
      >
        {(id) => (
          <TagInput
            id={id}
            values={adminPhones}
            onChange={(values) => onChange({ adminPhones: values.map(v => v.replace(/\D/g, '')) })}
            placeholder="Enter phone number"
            validate={validatePhone}
            accentColor={showConfirmed && adminPhones.length > 0 ? 'var(--wizard-accent)' : undefined}
          />
        )}
      </Field>
    </WizardStep>
  )
}

export default IdentityStep
