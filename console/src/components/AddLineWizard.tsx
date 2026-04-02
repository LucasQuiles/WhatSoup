import { type FC, useState, useCallback } from 'react'
import { X, Check } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import IdentityStep from './wizard/IdentityStep'
import ModelAuthStep from './wizard/ModelAuthStep'
import ConfigStep from './wizard/ConfigStep'
import ReviewStep from './wizard/ReviewStep'
import LinkStep from './wizard/LinkStep'
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
    style={{ padding: 'var(--sp-4) var(--sp-5)', gap: 'var(--sp-1)' }}
  >
    {steps.map((label, i) => {
      const completed = i < currentStep
      const active = i === currentStep
      return (
        <div key={label} className="flex items-center" style={{ gap: 'var(--sp-1)' }}>
          {i > 0 && (
            <div
              style={{
                width: 24,
                height: 1,
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
                    width: 6,
                    height: 6,
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
                fontSize: 'var(--font-size-xs)',
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

/* ── Wizard shell ── */
const AddLineWizard: FC<AddLineWizardProps> = ({ onClose }) => {
  const [currentStep, setCurrentStep] = useState(0)
  const [formData, setFormData] = useState<Record<string, unknown>>({
    type: 'chat',
    accessMode: 'self_only',
    adminPhones: [],
  })
  const [errors] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const patchForm = useCallback(
    (patch: Record<string, unknown>) => setFormData((d) => ({ ...d, ...patch })),
    [],
  )

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
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'var(--panel-wizard)',
          maxWidth: '90%',
          maxHeight: '85vh',
          background: 'var(--color-d2)',
          border: 'var(--bw) solid var(--b2)',
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
          <h2 className="c-heading">Add New Line</h2>
          <button onClick={onClose} className="c-btn c-btn-ghost">
            <X size={16} />
          </button>
        </div>

        {/* Stepper */}
        <WizardStepper steps={STEPS} currentStep={currentStep} />

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-5)' }}>
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
                <ModelAuthStep data={formData} onChange={patchForm} />
              )}
              {currentStep === 2 && (
                <ConfigStep data={formData} onChange={patchForm} />
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
            className="flex items-center justify-between c-toolbar"
            style={{ borderTop: 'var(--bw) solid var(--b1)' }}
          >
            <button
              className="c-btn c-btn-ghost"
              onClick={() =>
                currentStep > 0 ? setCurrentStep((s) => s - 1) : onClose()
              }
            >
              {currentStep > 0 ? 'Back' : 'Cancel'}
            </button>
            <button
              className="c-btn c-btn-primary"
              onClick={() => setCurrentStep((s) => s + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default AddLineWizard
