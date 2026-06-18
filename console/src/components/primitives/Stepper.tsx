/**
 * Stepper.tsx — non-interactive progress strip (stepper.md).
 *
 * Renders the locked v2 .soup-wiz-steps anatomy: numbered circles joined by
 * 1px hairline separators, with a two-state active/done modifier rail.
 * Originally extracted from AddLineWizard's inline WizardStepper (DD-43 P1,
 * showcase §23).
 *
 * Showcase §23 forward treatment (opt-in via `checkOnDone`): completed steps
 * render a ✓ glyph instead of the number and the active step gains a soft
 * mode-identity halo (the `soup-wiz-steps--forward` root modifier). The active
 * step's accent colour still resolves from the surrounding `wizard-accent-scope`
 * (`--wizard-accent`); the halo simply reuses it. Done steps settle to the
 * confirm-green (`--status-ok-solid`) — the two-colour rail.
 *
 * Accessibility (§12 status law): state must reach assistive tech as TEXT, never
 * by glyph or colour alone. With `showStateText` (default on) each step emits a
 * visually-hidden "Completed" / "Current step" / "Upcoming" label, and the ✓
 * glyph is decorative (aria-hidden). `aria-current="step"` still marks the
 * active step.
 *
 * CSS lives in `console/src/styles/composites.css` (the soup-wiz-steps block).
 * Tokens `--wiz-step-circle` (18px) and `--wiz-step-sep` (16px) live in
 * `tokens.component.css`. The primitive intentionally reuses the
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
  /**
   * Showcase §23 forward treatment: render a ✓ glyph (not the number) on
   * completed steps and apply the active-step mode-identity halo. Default false
   * preserves the original numbered, halo-less rail for bare consumers.
   */
  checkOnDone?: boolean;
  /**
   * Emit a visually-hidden state label (Completed / Current step / Upcoming) per
   * step for assistive tech (§12 status law — state as text, not glyph/colour
   * alone). Default true.
   */
  showStateText?: boolean;
}

const STATE_TEXT = {
  done: 'Completed',
  active: 'Current step',
  upcoming: 'Upcoming',
} as const;

export const Stepper: FC<StepperProps> = ({
  steps,
  currentStep,
  ariaLabel = 'Progress',
  checkOnDone = false,
  showStateText = true,
}) => (
  <div
    className={[
      'soup-wiz-steps',
      checkOnDone ? 'soup-wiz-steps--forward' : '',
    ].filter(Boolean).join(' ')}
    aria-label={ariaLabel}
  >
    {steps.map((label, i) => {
      const completed = i < currentStep;
      const active = i === currentStep;
      const state = completed ? 'done' : active ? 'active' : 'upcoming';
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
              {completed && checkOnDone ? (
                <span aria-hidden="true">✓</span>
              ) : (
                i + 1
              )}
            </span>
            <span className="soup-wiz-steps__label">{label}</span>
            {showStateText && (
              <span className="soup-wiz-steps__sr">{STATE_TEXT[state]}</span>
            )}
          </div>
        </div>
      );
    })}
  </div>
);
