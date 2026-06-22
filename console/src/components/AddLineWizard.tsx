/**
 * AddLineWizard — migrated to Modal primitive (B3 wave 4).
 *
 * Migration details:
 *   - Modal open size="lg" dismissable={false} (role-on-backdrop defect dies by construction)
 *   - open prop added (C-B3W4-3 mount contract: latched mount + reset-on-open)
 *   - ModalHeader + wizard step strip (Stepper primitive, extracted from inline
 *     WizardStepper per DD-43 P1) + ModalBody + conditional ModalFooter
 *   - Step strip rendered by Stepper primitive; CSS lives in composites.css
 *     (soup-wiz-steps block); markup is byte-faithful to the legacy inline strip
 *   - framer-motion removed; step transitions are instant (motion.md §1, C-B3W4-4)
 *   - TYPE_ACCENT map + inline --wizard-accent injection removed (WVR-014 retired)
 *   - accent delivered via data-line-type attribute on wizard-accent-scope wrapper
 *   - discard flow: option α — post-creation close keeps the instance (C-B3W4-2)
 *     "Save and close" is safe; deletion is an explicit dashboard action (LineDetail)
 *   - createError block moved to ModalBody (D2 duplicate-error fix)
 *   - ConfirmDialog exits the wizard subtree as a sibling fragment
 *   - SoupKitchen contract: this component expects open prop; caller uses latched mount
 */
import { type FC, useState, useCallback, useEffect, useRef } from 'react'
import { X, ChevronRight, ChevronLeft } from 'lucide-react'
import IdentityStep from './wizard/IdentityStep'
import ModelAuthStep from './wizard/ModelAuthStep'
import ConfigStep from './wizard/ConfigStep'
import ReviewStep from './wizard/ReviewStep'
import LinkStep from './wizard/LinkStep'
import ConfirmDialog from './ConfirmDialog'
import { Modal, ModalHeader, ModalBody, ModalFooter } from './primitives/Modal'
import { Button } from './primitives/Button'
import { Stepper } from './primitives'
import { api } from '../lib/api'
import { withDefaultAgentWorkspace } from '../lib/agent-cwd'
import { DEFAULT_PROVIDER_ID } from '../lib/providers'

interface AddLineWizardProps {
  /** Controls visibility. SoupKitchen latches mount on first open (C-B3W4-3). */
  open: boolean
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

/* ── Wizard shell ── */
const AddLineWizard: FC<AddLineWizardProps> = ({ open, onClose }) => {
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
      provider: DEFAULT_PROVIDER_ID,
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

  // Reset-on-open: when the wizard re-opens after a close, reset to step 0 with
  // fresh state (C-B3W4-3). The latched mount keeps the component alive between
  // opens; this effect restores the initial condition so the user always starts
  // at Identity — the same guarantee legacy got for free from unmount.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setCurrentStep(0)
      setFormData({
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
          provider: DEFAULT_PROVIDER_ID,
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
      setErrors({})
      setCreating(false)
      setCreateError(null)
      isDirtyRef.current = false
      setShowConfirmExit(false)
      setInstanceCreated(false)
      setWizardCompleted(false)
      setLineLinked(false)
      setLockedName(null)
    }
    prevOpenRef.current = open
  }, [open])

  const patchForm = useCallback(
    (patch: Record<string, unknown>) => {
      isDirtyRef.current = true
      setFormData((d) => ({ ...d, ...patch }))
    },
    [],
  )

  const [instanceCreated, setInstanceCreated] = useState(false)
  const [wizardCompleted, setWizardCompleted] = useState(false)
  const [lineLinked, setLineLinked] = useState(false)

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
    const nextFormData = withDefaultAgentWorkspace(formData)
    if (nextFormData !== formData) setFormData(nextFormData)
    const errs = validateStep(currentStep, nextFormData)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    // Create the instance when advancing from Identity to Link
    // so the auth process has a config dir to write QR keys to
    if (currentStep === 0 && !instanceCreated) {
      setCreating(true)
      setCreateError(null)
      try {
        await api.createLine(nextFormData)
        setInstanceCreated(true)
        setLockedName(nextFormData.name as string)
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

  // Option α (C-B3W4-2): post-creation close KEEPS the instance (save unlinked).
  // The user can link it later from the dashboard (LineDetail delete is the
  // explicit destructive action with consequence copy — never silent deletion).
  // Pre-creation discard: nothing was provisioned, nothing to keep.
  const handleConfirmDiscard = useCallback(async () => {
    // No deleteLine call here — the instance is kept unlinked (option α).
    // Legacy called api.deleteLine here; that contradicted the confirm copy's
    // "You can reconfigure it later from the dashboard" promise (D1 defect).
    onClose()
  }, [onClose])

  const handleCreateLine = useCallback(async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const nextFormData = withDefaultAgentWorkspace(formData)
      if (nextFormData !== formData) setFormData(nextFormData)
      // Instance already created at step 0→1 transition. Update config with final settings.
      await api.updateConfig(nextFormData.name as string, nextFormData)
      // Instance already linked + running from step 1. Config saved. Done.
      setWizardCompleted(true)
      onClose()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [formData, onClose])

  // Accent: delivered via data-line-type; CSS resolves --wizard-accent statically
  // (WVR-014 retired — no runtime injection, no CSSProperties cast needed).
  const lineType = (formData.type as string) || undefined

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        size="lg"
        dismissable={false}
      >
        <ModalHeader title="Add New Line" onClose={handleClose} />

        {/* Step strip — Stepper primitive (DD-43 P1 extraction). checkOnDone
            adopts the showcase §23 forward treatment: ✓ on done steps + the
            active-step mode-identity halo. The strip carries its own
            wizard-accent-scope so --wizard-accent resolves here (the ModalBody
            scope below does not enclose it): neutral confirm-green pre-selection,
            the line-mode colour once a type is picked. */}
        <div className="wizard-accent-scope" data-line-type={lineType}>
          <Stepper steps={STEPS} currentStep={currentStep} ariaLabel="Wizard progress" checkOnDone />
        </div>

        <ModalBody>
          {/* wizard-accent-scope carries data-line-type for static CSS accent resolution */}
          <div className="wizard-accent-scope" data-line-type={lineType}>
            {/* createError in body anatomy (D2: no longer duplicated in footer + ReviewStep) */}
            {createError && currentStep !== 4 && (
              <div className="flex items-center gap-[var(--sp-2)] text-s-crit py-[var(--sp-2)] px-[var(--sp-3)] bg-[var(--surface-raised)] rounded-sm text-data mb-[var(--sp-3)]">
                <X size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                <span>{createError}</span>
              </div>
            )}

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
                alreadyLinked={lineLinked}
                onComplete={() => {
                  setLineLinked(true)
                  setCurrentStep(2)
                }}
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
          </div>
        </ModalBody>

        {/* Footer — hidden on Link (step 1, has own controls) */}
        {currentStep !== 1 && (
          <ModalFooter
            note={instanceCreated ? (
              <span className="text-data text-2">
                Your line is provisioned and can be configured from the dashboard.
              </span>
            ) : undefined}
          >
            <Button
              variant="ghost"
              icon={currentStep > 0 ? <ChevronLeft size={16} strokeWidth={1.75} /> : undefined}
              iconEnd={currentStep === 0 ? <X size={16} strokeWidth={1.75} /> : undefined}
              onClick={() =>
                currentStep > 0 ? setCurrentStep((s) => s - 1) : handleClose()
              }
              disabled={creating}
            >
              {currentStep > 0 ? 'Back' : 'Cancel'}
            </Button>
            {/* Hide Next on Review step — ReviewStep has its own Create button */}
            {currentStep !== 4 && (
              <Button
                variant="primary"
                iconEnd={!creating ? <ChevronRight size={16} strokeWidth={1.75} /> : undefined}
                onClick={handleNext}
                loading={creating}
                disabled={creating}
              >
                {creating ? 'Creating…' : 'Next'}
              </Button>
            )}
          </ModalFooter>
        )}
      </Modal>

      {/* Exit confirmation dialog — sibling fragment, NOT inside the dialog subtree (C-B3W4-3) */}
      <ConfirmDialog
        open={showConfirmExit}
        title={instanceCreated ? 'Abandon new line?' : 'Discard changes?'}
        confirmLabel={instanceCreated ? 'Save and close' : 'Discard'}
        confirmVariant={instanceCreated ? 'primary' : 'danger'}
        onConfirm={handleConfirmDiscard}
        onCancel={() => setShowConfirmExit(false)}
      >
        {instanceCreated
          ? `The line "${formData.name}" has been created. Save and close to keep it unlinked — you can configure and link it later from the dashboard. To delete it, use the delete action on the dashboard.`
          : 'You have unsaved configuration. Closing the wizard will discard all changes.'}
      </ConfirmDialog>
    </>
  )
}

export default AddLineWizard
