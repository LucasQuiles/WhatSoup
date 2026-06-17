/**
 * Stepper.tsx — non-interactive progress strip (stepper.md).
 *
 * Renders the locked v2 .soup-wiz-steps anatomy: numbered circles joined by
 * 1px hairline separators, with a two-state active/done modifier rail.
 * Originally extracted from AddLineWizard's inline WizardStepper (DD-43 P1,
 * showcase §23) — markup, classes, and a11y are preserved verbatim so the
 * wizard's rendered DOM is byte-identical before/after.
 *
 * Non-interactive by construction (spans, not buttons) — gated linear flow
 * semantics, not tab semantics. The active step adopts the line-mode identity
 * color via the surrounding `wizard-accent-scope` (no in-primitive accent
 * prop yet; the showcase's "active step mode-identity" coloring is a future
 * leaf).
 *
 * CSS lives in `console/src/styles/composites.css` (the soup-wiz-steps
 * block). Tokens `--wiz-step-circle` (18px) and `--wiz-step-sep` (16px) live
 * in `tokens.component.css`. The primitive intentionally reuses the
 * `.soup-wiz-steps*` classes — it does NOT introduce a new BEM family.
 */
import { type FC } from 'react';

export interface StepperProps {
  /** Step labels in display order. Length determines the rail length. */
  steps: readonly string[];
  /** Index of the current step (0-based). */
  currentStep: number;
  /** Accessible name for the strip. Defaults to "Progress". */
  ariaLabel?: string;
}

export const Stepper: FC<StepperProps> = ({
  steps,
  currentStep,
  ariaLabel = 'Progress',
}) => (
  <div
    className="soup-wiz-steps"
    aria-label={ariaLabel}
  >
    {steps.map((label, i) => {
      const completed = i < currentStep;
      const active = i === currentStep;
      return (
        <div key={label} className="soup-wiz-steps__item">
          {i > 0 && (
            <div
              className="soup-wiz-steps__sep"
              aria-hidden="true"
            />
          )}
          <div
            className={[
              'soup-wiz-steps__step',
              active ? 'soup-wiz-steps__step--active' : '',
              completed ? 'soup-wiz-steps__step--done' : '',
            ].filter(Boolean).join(' ')}
            aria-current={active ? 'step' : undefined}
          >
            <span className="soup-wiz-steps__circle">
              {i + 1}
            </span>
            <span className="soup-wiz-steps__label">{label}</span>
          </div>
        </div>
      );
    })}
  </div>
);
