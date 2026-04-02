import { type FC, useState, useCallback, useRef } from 'react'
import { X, Check } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import IdentityStep from './wizard/IdentityStep'
import ModelAuthStep from './wizard/ModelAuthStep'
import ConfigStep from './wizard/ConfigStep'
import ReviewStep from './wizard/ReviewStep'
import LinkStep from './wizard/LinkStep'
import ConfirmDialog from './ConfirmDialog'
import { api } from '../lib/api'

interface AddLineWizardProps {
  onClose: () => void
}

const STEPS = ['Identity', 'Model', 'Config', 'Review', 'Link'] as const

/* ── Stepper sub-component ── */
const WizardStepper: FC<{ steps: readonly string[]; currentStep: number }> = ({
  steps,
  currentStep,
}) => (
  <div
    className="flex items-center justify-center flex-shrink-0"
    style={{ padding: 'var(--sp-4) var(--sp-5)', gap: 'var(--sp-1)', marginBottom: 'var(--sp-4)' }}
  >
    {steps.map((label, i) => {
      const completed = i < currentStep
      const active = i === currentStep
      return (
        <div key={label} className="flex items-center" style={{ gap: 'var(--sp-1)' }}>
          {i > 0 && (
            <div
              style={{
                width: 'var(--stepper-line-w)',
                height: 'var(--bw)',
                background: completed ? 'var(--color-s-ok)' : 'var(--color-t5)',
                opacity: completed ? 1 : 0.4,
                transition: 'background 0.2s ease',
              }}
            />
          )}
          <div className="flex flex-col items-center" style={{ gap: 'var(--sp-1)' }}>
            <div
              className="flex items-center justify-center"
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: completed || active ? 'var(--color-s-ok)' : 'transparent',
                border: `var(--bw) solid ${completed || active ? 'var(--color-s-ok)' : 'var(--color-t5)'}`,
                transition: 'all 0.2s ease',
              }}
            >
              {completed ? (
                <Check size={11} strokeWidth={2.5} style={{ color: 'var(--color-d0)' }} />
              ) : (
                <div
                  style={{
                    width: 'var(--stepper-dot)',
                    height: 'var(--stepper-dot)',
                    borderRadius: '50%',
                    background: active ? 'var(--color-d0)' : 'var(--color-t5)',
                    opacity: active ? 1 : 0.5,
                  }}
                />
              )}
            </div>
            <span
              className="font-mono font-medium"
              style={{
                fontSize: 'var(--font-size-label)',
                letterSpacing: 'var(--tracking-label)',
                color: active ? 'var(--color-s-ok)' : completed ? 'var(--color-t2)' : 'var(--color-t5)',
                transition: 'color 0.2s ease',
              }}
            >
              {label}
            </span>
          </div>
        </div>
      )
    })}
  </div>
)

/* ── Step validation ── */
const validateStep = (step: number, formData: Record<string, unknown>): Record<string, string> => {
  const errs: Record<string, string> = {}
  if (step === 0) {
    const name = (formData.name as string) ?? ''
    if (!name || name.length < 2) errs.name = 'Name must be at least 2 characters'
    else if (!/^[a-z][a-z0-9-]*$/.test(name)) errs.name = 'Lowercase letters, numbers, and hyphens only'
    if (!formData.type) errs.type = 'Select a line type'
    const phones = formData.adminPhones as string[]
    if (!phones || phones.length === 0) errs.adminPhones = 'At least one admin phone is required'
  }
  if (step === 1 && formData.type !== 'passive') {
    if (formData.type === 'chat' && !formData.apiKey) errs.apiKey = 'API key is required for chat instances'
    if (formData.type === 'agent' && (formData.authMethod ?? 'api_key') === 'api_key' && !formData.apiKey) errs.apiKey = 'API key is required'
  }
  if (step === 2) {
    if (formData.type !== 'passive' && !formData.systemPrompt) errs.systemPrompt = 'System prompt is required'
    if (formData.type === 'agent') {
      const ao = formData.agentOptions as Record<string, unknown> | undefined
      if (!ao?.cwd || !(ao.cwd as string).trim()) errs.cwd = 'Working directory is required for agent instances'
    }
  }
  return errs
}

const TYPE_ACCENT: Record<string, string> = {
  passive: 'var(--color-m-pas)',
  chat: 'var(--color-m-cht)',
  agent: 'var(--color-m-agt)',
}

/* ── Wizard shell ── */
const AddLineWizard: FC<AddLineWizardProps> = ({ onClose }) => {
  const [currentStep, setCurrentStep] = useState(0)
  const [formData, setFormData] = useState<Record<string, unknown>>({
    type: 'chat',
    accessMode: 'self_only',
    adminPhones: [],
    agentOptions: {
      cwd: '',
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox: {
        allowedPaths: [],
        bash: { enabled: true, pathRestricted: true },
      },
      mcp: { send_media: true },
      perUserDirs: { enabled: false, basePath: 'users' },
    },
    models: {
      conversation: 'claude-sonnet-4-6',
      extraction: 'claude-haiku-4-5-20251001',
      validation: 'claude-haiku-4-5-20251001',
      fallback: 'gpt-4.1',
    },
    rateLimitPerHour: 60,
    maxTokens: 4096,
    tokenBudget: 50000,
    toolUpdateMode: 'full',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const isDirtyRef = useRef(false)
  const [showConfirmExit, setShowConfirmExit] = useState(false)

  const patchForm = useCallback(
    (patch: Record<string, unknown>) => {
      isDirtyRef.current = true
      setFormData((d) => ({ ...d, ...patch }))
    },
    [],
  )

  const handleNext = useCallback(() => {
    const errs = validateStep(currentStep, formData)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setCurrentStep((s) => s + 1)
  }, [currentStep, formData])

  const handleClose = useCallback(() => {
    if (isDirtyRef.current) {
      setShowConfirmExit(true)
    } else {
      onClose()
    }
  }, [onClose])

  const handleCreateLine = useCallback(async () => {
    setCreating(true)
    setCreateError(null)
    try {
      await api.createLine(formData)
      setCurrentStep(4)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [formData])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--overlay)' }}
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="wizard-accent-scope"
        style={{
          '--wizard-accent': TYPE_ACCENT[(formData.type as string) ?? 'chat'],
          width: 'var(--panel-wizard)',
          maxWidth: '90%',
          maxHeight: 'var(--modal-max-h)',
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)',
          borderStyle: 'solid',
          borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <h2 className="c-heading-lg">Add New Line</h2>
          <button onClick={handleClose} className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* Stepper */}
        <WizardStepper steps={STEPS} currentStep={currentStep} />

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-6)' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              {currentStep === 0 && (
                <IdentityStep
                  data={formData}
                  onChange={patchForm}
                  errors={errors}
                />
              )}
              {currentStep === 1 && (
                <ModelAuthStep data={formData} onChange={patchForm} errors={errors} />
              )}
              {currentStep === 2 && (
                <ConfigStep data={formData} onChange={patchForm} errors={errors} />
              )}
              {currentStep === 3 && (
                <ReviewStep
                  data={formData}
                  onEditPhase={(phase) => setCurrentStep(phase)}
                  onCreateLine={handleCreateLine}
                  creating={creating}
                  error={createError}
                />
              )}
              {currentStep === 4 && (
                <LinkStep
                  lineName={formData.name as string}
                  onComplete={onClose}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer — hidden on Review (has own CTA) and Link (has own controls) */}
        {currentStep < 3 && (
          <div
            className="flex items-center justify-end c-toolbar"
            style={{ borderTop: 'var(--bw) solid var(--b1)', gap: 'var(--sp-3)' }}
          >
            <button
              className="c-btn c-btn-ghost"
              onClick={() =>
                currentStep > 0 ? setCurrentStep((s) => s - 1) : handleClose()
              }
            >
              {currentStep > 0 ? 'Back' : 'Cancel'}
            </button>
            <button
              className="c-btn c-btn-primary"
              onClick={handleNext}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Exit confirmation dialog */}
      <ConfirmDialog
        open={showConfirmExit}
        title="Discard changes?"
        confirmLabel="Discard"
        confirmVariant="danger"
        onConfirm={onClose}
        onCancel={() => setShowConfirmExit(false)}
      >
        You have unsaved configuration. Closing the wizard will discard all changes.
      </ConfirmDialog>
    </div>
  )
}

export default AddLineWizard
