import { type FC, type ReactNode } from 'react'

interface WizardStepProps {
  /** Optional short heading displayed above the body. */
  title?: string

  /** Optional one-line description below the title. */
  subtitle?: string

  /**
   * Slot rendered after the body, inside the step container but before
   * the parent footer. Use for bespoke per-step actions (e.g. ConfigStep's
   * "Skip — Use Defaults" button). Null/undefined = nothing rendered.
   */
  footerExtra?: ReactNode

  /** Body content — the form fields, cards, etc. */
  children: ReactNode
}

const WizardStep: FC<WizardStepProps> = ({ title, subtitle, footerExtra, children }) => (
  <div className="flex flex-col gap-[var(--sp-4)]">
    {(title || subtitle) && (
      <div className="flex flex-col gap-[var(--sp-1)]">
        {title && <h3 className="c-heading">{title}</h3>}
        {subtitle && <p className="c-body text-text-2">{subtitle}</p>}
      </div>
    )}
    {children}
    {footerExtra && (
      <div className="flex justify-end mt-[var(--sp-4)] pt-[var(--sp-3)] c-border-t">
        {footerExtra}
      </div>
    )}
  </div>
)

export default WizardStep
