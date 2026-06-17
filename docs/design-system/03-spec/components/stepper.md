# Stepper — non-interactive progress strip with two-state active/done rail

v3.0.0-draft · G2-locked direction · pending G3

Resolves DD-43 P1: extract the wizard-local progress strip into a reusable primitive without
changing the wizard's rendered output. Locked source: `console/src/components/AddLineWizard.tsx`
inline `WizardStepper` (B3W4 option c) and the v2 `.soup-wiz-steps` anatomy in
`console/src/styles/composites.css`.

## Anatomy

```
soup-wiz-steps (flex, --sp-1 gap, padding --sp-3 --sp-5, hairline bottom)
└─ soup-wiz-steps__item (per label, in order)
   ├─ [if i>0] soup-wiz-steps__sep (1px hairline, --wiz-step-sep wide, --border-subtle, aria-hidden)
   └─ soup-wiz-steps__step (mono label + circle, gap --sp-1h)
      ├─ soup-wiz-steps__circle (--wiz-step-circle diameter, mono numeral)
      └─ soup-wiz-steps__label (mono, --text-label, --tracking-label)
```

Tokens: `--wiz-step-circle: 18px` (circle diameter), `--wiz-step-sep: 16px` (separator width).
Both live in `console/src/styles/tokens.component.css`.

## Conceptual props

`steps: readonly string[]` · `currentStep: number` (0-based) · `ariaLabel?: string` (default
`"Progress"`).

## States

- **default** (future step, `i > currentStep`): circle border `--text-3`, label `--text-3`
- **active** (current step, `i === currentStep`): adds `soup-wiz-steps__step--active`;
  `aria-current="step"`; active ink resolves to `--wizard-accent` when the strip sits inside a
  `wizard-accent-scope` (wizard), otherwise falls back to `--status-ok-solid`
- **done** (completed step, `i < currentStep`): adds `soup-wiz-steps__step--done`; done circle +
  label adopt `--status-ok-solid`

The primitive preserves the locked two-state rail: it does NOT paint a per-mode accent on the
active step yet. **Active-step mode-identity coloring (showcase §23) is a future leaf** — at that
point an `accent?` prop or a `data-line-type` contract on the primitive can replace the
surrounding-scope fallback. The extraction here is behavior-preserving; the active ring keeps
resolving through `--wizard-accent` from the existing scope wrapper.

## Accessibility

Non-interactive by construction: spans only, no buttons, no `role="tab"`. The container is a
labelled region (`aria-label` on the root; default `"Progress"`, callers pass contextual names
like `"Wizard progress"`); the active step carries `aria-current="step"` (single-fire); separators
carry `aria-hidden="true"`. Semantics are **gated linear flow**, not tab semantics — the rail
visualises progress through a fixed sequence, it does not switch panels.

Keyboard: nothing to reach. The strip is decorative for sighted users and a status region for AT.

## Examples / anti-patterns

- Do: `AddLineWizard` 5-step rail (`Identity → Link → Model → Config → Review`); the operator
  onboarding wizard; any linear multi-step flow that needs a status visualisation, not a switcher.
- Don't: use the stepper for **navigable** multi-section UI — that wants `Tabs` (tablist with
  roving tabindex and panel switching); don't re-roll a new BEM family — the primitive reuses
  `.soup-wiz-steps*` deliberately to avoid a second dialect; don't add buttons/click handlers —
  gated flow is read-only status.

## Migration notes

- The wizard's inline `WizardStepper` (`console/src/components/AddLineWizard.tsx`, pre-DD-43 P1)
  dies; consumers import `Stepper` from `./primitives`. The wizard's rendered DOM is
  byte-identical before/after (same `.soup-wiz-steps*` classes, same `aria-label="Wizard
  progress"`).
- `console/src/styles/composites.css` (soup-wiz-steps block) and `tokens.component.css`
  (`--wiz-step-*`) are unchanged — no new tokens, no new selectors.
- Future migration candidates: wizard step strips in operator onboarding; any internal
  multi-stage tool that wants a status rail (NOT a step picker).

## Enforcement hooks

`stepper-via-primitive` (wizard step strips must consume the primitive; no inline re-rolls);
no-buttons rule (the rail is read-only status — interactive variants would be a different
primitive); one-dialect rule (no new BEM families — only `.soup-wiz-steps*`).
