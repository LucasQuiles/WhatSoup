import { type FC, useState, useCallback, useEffect, useRef } from 'react'
import { X, Check, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react'
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

/**
 * STEP INDEX MAP — Keep in sync with:
 * - Step rendering (currentStep === N)
 * - ReviewStep.tsx onEditPhase(N) calls
 * - handleNext() step-specific logic
 * - Footer visibility conditions
 *
 * 0 = Identity, 1 = Link, 2 = Model, 3 = Config, 4 = Review
 */
const STEPS = ['Identity', 'Link', 'Model', 'Config', 'Review'] as const

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
                transition: 'background var(--dur-norm) var(--ease)',
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
                borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: completed || active ? 'var(--color-s-ok)' : 'var(--color-t5)',
                transition: 'all var(--dur-norm) var(--ease)',
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
                transition: 'color var(--dur-norm) var(--ease)',
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

/* ── Step validation ──
 * Principle: normalize first, then validate the normalized value.
 * Never reject what can be silently fixed (case, whitespace, formatting).
 * Only block on genuinely missing or invalid data.
 */
const validateStep = (step: number, formData: Record<string, unknown>): Record<string, string> => {
  const errs: Record<string, string> = {}
  if (step === 0) {
    if (!formData.type) errs.type = 'Choose a line type to continue'
    const raw = (formData.name as string) ?? ''
    const name = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!name || name.length < 2) errs.name = 'Enter a name — at least 2 characters (letters, numbers, hyphens)'
    const phones = formData.adminPhones as string[]
    if (!phones || phones.length === 0) errs.adminPhones = 'Add at least one admin phone number, then press Enter'
  }
  if (step === 3) {
    if (formData.type !== 'passive' && !formData.systemPrompt) errs.systemPrompt = 'Add a system prompt — this defines how the AI responds'
    if (formData.type === 'agent') {
      const ao = formData.agentOptions as Record<string, unknown> | undefined
      if (!ao?.cwd || !(ao.cwd as string).trim()) errs.cwd = 'Set a working directory — the agent needs a home folder for files and sessions'
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
    type: '',
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
      provider: 'claude-cli',
      providerConfig: {},
    },
    models: {
      conversation: 'claude-sonnet-4-6',
      extraction: 'claude-haiku-4-5-20251001',
      validation: 'claude-haiku-4-5-20251001',
      fallback: '',
      openaiExtraction: '',
      openaiValidation: '',
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

  const [instanceCreated, setInstanceCreated] = useState(false)
  const [wizardCompleted, setWizardCompleted] = useState(false)

  // Warn user about tab close when instance is created but wizard incomplete
  useEffect(() => {
    if (!instanceCreated || wizardCompleted) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [instanceCreated, wizardCompleted])

  // Lock the instance name after creation to prevent orphaned instances on back-nav
  const [lockedName, setLockedName] = useState<string | null>(null)

  const handleNext = useCallback(async () => {
    const errs = validateStep(currentStep, formData)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    // Create the instance when advancing from Identity to Link
    // so the auth process has a config dir to write QR keys to
    if (currentStep === 0 && !instanceCreated) {
      setCreating(true)
      setCreateError(null)
      try {
        await api.createLine(formData)
        setInstanceCreated(true)
        setLockedName(formData.name as string)
        setCurrentStep(1)
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(false)
      }
      return
    }

    setCurrentStep((s) => s + 1)
  }, [currentStep, formData, instanceCreated])

  const handleClose = useCallback(() => {
    if (instanceCreated) {
      // Instance was provisioned — confirm before abandoning
      setShowConfirmExit(true)
    } else if (isDirtyRef.current) {
      setShowConfirmExit(true)
    } else {
      onClose()
    }
  }, [onClose, instanceCreated])

  // Cleanup: if user confirms discard after instance was created, tear it down
  const handleConfirmDiscard = useCallback(async () => {
    if (instanceCreated && formData.name) {
      try {
        await api.deleteLine(formData.name as string)
      } catch (err) {
        console.warn('deleteLine failed during discard:', err)
      }
    }
    onClose()
  }, [instanceCreated, formData.name, onClose])

  const handleCreateLine = useCallback(async () => {
    setCreating(true)
    setCreateError(null)
    try {
      // Instance already created at step 0→1 transition. Update config with final settings.
      await api.updateConfig(formData.name as string, formData)
      // Instance already linked + running from step 1. Config saved. Done.
      setWizardCompleted(true)
      onClose()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [formData, onClose])

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
          '--wizard-accent': TYPE_ACCENT[(formData.type as string)] ?? 'var(--color-s-ok)',
          width: 'var(--panel-wizard)',
          minWidth: 'var(--panel-wizard)',
          maxWidth: '90%',
          minHeight: '500px',
          height: 'var(--modal-max-h)',
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
                  nameLocked={!!lockedName}
                />
              )}
              {currentStep === 1 && (
                <LinkStep
                  lineName={formData.name as string}
                  onComplete={() => setCurrentStep(2)}
                />
              )}
              {currentStep === 2 && (
                <ModelAuthStep data={formData} onChange={patchForm} errors={errors} />
              )}
              {currentStep === 3 && (
                <ConfigStep data={formData} onChange={patchForm} errors={errors} onSkip={handleNext} />
              )}
              {currentStep === 4 && (
                <ReviewStep
                  data={formData}
                  onEditPhase={(phase) => setCurrentStep(phase)}
                  onCreateLine={handleCreateLine}
                  creating={creating}
                  error={createError}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer — hidden on Link (step 1, has own controls) and Review (step 4, has own CTA) */}
        {currentStep !== 1 && currentStep !== 4 && (
          <div
            className="flex flex-col c-toolbar"
            style={{ borderTop: 'var(--bw) solid var(--b1)', gap: 'var(--sp-2)' }}
          >
            {createError && (
              <div
                className="flex items-center"
                style={{
                  gap: 'var(--sp-2)',
                  fontSize: 'var(--font-size-data)',
                  color: 'var(--color-s-crit)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  background: 'var(--color-d3)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <X size={14} style={{ flexShrink: 0 }} />
                <span>{createError}</span>
              </div>
            )}
            <div className="flex items-center justify-end" style={{ gap: 'var(--sp-3)' }}>
            <button
              className="c-btn c-btn-ghost c-btn-nav"
              onClick={() =>
                currentStep > 0 ? setCurrentStep((s) => s - 1) : handleClose()
              }
              disabled={creating}
            >
              {currentStep > 0 && <ChevronLeft size={16} />}
              <span className="c-btn-nav-label">{currentStep > 0 ? 'Back' : 'Cancel'}</span>
              {currentStep === 0 && <X size={16} />}
            </button>
            <button
              className="c-btn c-btn-primary c-btn-nav"
              onClick={handleNext}
              disabled={creating}
            >
              {creating ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span className="c-btn-nav-label">Creating...</span>
                </>
              ) : (
                <>
                  <span className="c-btn-nav-label">Next</span>
                  <ChevronRight size={16} />
                </>
              )}
            </button>
            </div>
          </div>
        )}
      </div>

      {/* Exit confirmation dialog */}
      <ConfirmDialog
        open={showConfirmExit}
        title={instanceCreated ? 'Abandon new line?' : 'Discard changes?'}
        confirmLabel={instanceCreated ? 'Abandon' : 'Discard'}
        confirmVariant="danger"
        onConfirm={handleConfirmDiscard}
        onCancel={() => setShowConfirmExit(false)}
      >
        {instanceCreated
          ? `The instance "${formData.name}" has been created and linked. Abandoning will stop it. You can reconfigure it later from the dashboard.`
          : 'You have unsaved configuration. Closing the wizard will discard all changes.'}
      </ConfirmDialog>
    </div>
  )
}

export default AddLineWizard
