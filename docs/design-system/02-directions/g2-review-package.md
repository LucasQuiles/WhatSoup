# G2 Review Package - SOUP v2 Blend

Status: **G2 open; T6/T7/T8 blocked until explicit user approval.**

Review source:
- Mockup: `02-directions/iterations/v2.html`
- Decision record: `02-directions/decision-log.md`
- Evidence log: `docs/design-system/execution-log.md`

Recommendation: **Option A - lock v2 Blend with conditions.** The direction is coherent enough for T6/T7. The remaining issues should become mandatory spec/enforcement criteria unless user review finds them visually or structurally unacceptable.

## Direction Lock Summary

| Area | Proposed lock |
|---|---|
| Visual language | B Editorial chassis: restrained surfaces, exact hierarchy, mature light mode, and operator-grade density. A and C grafts are integrated as brand/status and operational layers. |
| Typography | Geist for UI, Geist Mono for data/nameplate. Closed type ramp: display, title, heading, body, label, caption, overline, data-lg, data, data-sm, and reserved `--type-nameplate`. |
| Dark palette | `#0E1013` base, `#15181D` raised, `#1B1F26` overlay, `#0A0C0E` inset; white-alpha hairline/subtle/strong borders; `#E8EAEE`, `#9AA2AD`, `#6B7480` text ladder. |
| Light palette | `#FAFAFA` base, `#FFFFFF` raised/overlay, `#F1F2F4` inset; black-alpha borders; `#1A1D21`, `#555C66`, `#8A919C` text ladder; real shadow replaces dark-mode luminance elevation. |
| Accent strategy | Electric blue accent: `#6BA6FF` dark, `#2563EB` light. Accent is for primary action, focus, and selected/active affordance; status colors remain semantic and separate. |
| Motion strategy | Instant/120/180/280ms tokens; enter `cubic-bezier(0.2,0,0,1)`, exit `cubic-bezier(0.4,0,1,1)`, linear opacity; exits faster than entrances; reduced motion is off-and-instant. Single ambient loop allowed: online-breathing status only. |
| SOUP naming/nameplate | UI-facing brand is SOUP. The mark uses mono spaced-caps nameplate treatment, one teal square tick, and reserved nameplate type style. Internal/protocol `WhatSoup` remains protected. |
| State taxonomy | Default, hover, focus-visible, active, selected, disabled, loading, empty, success, warning/degraded, critical/unreachable, offline/unlinked, pending/syncing, stale, validation error, destructive confirmation, reduced motion. |
| Shape-coded status | Binding law: disc = online, diamond = degraded, square = unreachable, outline disc = unlinked/offline. Shape is always paired with text; hue alone is never sufficient. |
| Density model | Two table/list densities only: 36px default and 28px compressed. Forms and browse surfaces default to 36px; operational tables may use 28px with target-size and interaction safeguards. |
| Table strategy | One table component with sticky ghost headers, mono-aligned numeric columns, semantic row severity, consistent truncation, and density tokens. Avoid card-only dense data. |
| Log-stream strategy | First-class log block: time / level / component / message grid, E/W/I/D tags, level filtering, row expansion, scoped logs in drawer and service logs in main flow. |
| Drawer/inspector strategy | Contextual line inspector over Fleet frame with status, key facts, remedies, and scoped log. Spec must replace pure overlay with squeeze-layout behavior for compressed table columns. |
| Toolbar anatomy | One repeated toolbar anatomy: `[filters | time-range . search . primary]`, used for Fleet, logs, and future data surfaces. |

## Open Item Disposition

| Item | Classification | Required disposition |
|---|---|---|
| Drawer overlays compressed table right columns. | G2 conditional approval item; T6 spec requirement; T7 cutover requirement. | Define a production squeeze-layout rule: when inspector opens, the table frame yields width, preserves priority columns, and truncates/deprioritizes trailing columns by documented order. Do not leave this as vague overlay behavior. |
| Nameplate tracking and optical centering need refinement. | G2 conditional approval item; T6 brand/spec requirement; optional Round 2 visual iteration item. | Specify tracking, trailing-space compensation, tick size/placement, optical centering, minimum width, and where the reserved nameplate style may appear. |
| Utility-class/spec-smell areas must become primitives/composites. | G2 conditional approval item; T6 spec requirement; T7 enforcement/cutover requirement. | Replace mockup utility patterns such as width/margin shortcuts with named layout primitives, composites, or documented anti-patterns before implementation planning. |

Default recommendation: treat all three as conditional approval items. They do not require reopening the direction unless user review finds them unacceptable.

## G2 Decision Options

### Option A - Lock v2 Blend With Conditions

Proceed to T6/T7 using v2 Blend as the locked direction. Carry the three open items into T6/T7 as mandatory resolution criteria.

This is the recommended option.

### Option B - Run Round 2 Iteration

Perform one targeted iteration only, focused on drawer squeeze-layout, nameplate optical centering, utility/spec-smell cleanup, and any specific user-requested visual refinements.

Do not reopen the entire direction space.

### Option C - Do Not Lock

Pause and request specific user feedback on what failed:
- visual language;
- density;
- palette;
- motion;
- naming;
- status system;
- table/log strategy;
- overall product feel.

## Optional T8 Decision

T8 is optional and must be explicitly approved. It is **not required** for G2 lock.

If approved:
- T8 is a throwaway token-value swap in the live console only to sanity-check the chosen palette against real data.
- T8 runs only inside the isolated worktree.
- T8 does not become implementation.
- T8 must be fully reverted before G3.
- T8 produces notes/screenshots only.

If declined:
- Proceed with spec-only validation through T6/T7.

Recommendation: **optional.** Use T8 only if the user wants real-console palette sanity evidence before G3; otherwise decline it and keep the program purely spec-driven.

## After G2 Approval Only

Do not start these tasks until explicit G2 approval is recorded.

### T6 Formal Spec Driver

Produce/finalize:
- `03-spec/tokens-v3.md`
- `03-spec/typography.md`
- `03-spec/color.md`
- `03-spec/layout-density.md`
- `03-spec/motion.md`
- `03-spec/interaction-patterns.md`
- `03-spec/iconography.md`
- `03-spec/components/*.md`
- `03-spec/brand.md`

Mandatory T6 criteria:
- Every v2 Blend token is formalized, rejected, or mapped to an approved semantic/component token.
- No accepted design decision lives only in the mockup.
- Shape-coded statuses are binding law and always paired with text labels.
- Density model is explicit: 36px default, 28px compressed, when each is allowed, and minimum target-size implications.
- Motion rules include enter/exit timing, faster exits, reduced-motion off/instant behavior, and ambient-motion limits.
- Glass/material effects are restricted to header chrome and scrim unless explicitly justified.
- Drawer behavior includes the squeeze-layout rule.
- Nameplate spacing, tracking, tick placement, and optical centering are specified.
- Utility/spec-smell patterns are converted into named primitives, composites, or anti-patterns.

### T7 Enforcement and Cutover Driver

Produce/finalize:
- `04-enforcement/lint-plan.md`
- `05-cutover/cutover-plan.md`
- `05-cutover/branding-touchpoints.md`

Mandatory T7 criteria:
- Enforcement starts report-only and progresses toward steady-state hard failure only after migration paths exist.
- UI-facing SOUP copy remains distinct from protected internal/protocol `WhatSoup` identifiers.
- Focus-visible and modal focus restoration are planned as enforceable expectations.
- Legacy tokens, raw controls, and utility/spec-smell patterns have migration paths before hard bans.
- Cutover phases remain reversible and forbid unrelated refactors/product changes.
- Table/log/drawer strategy has a dense + expressive + transactional rehearsal path before broad migration.
- Exceptions require owner, reason, affected files, expiration, and cleanup condition.

## G3 Readiness Package

After T6/T7, prepare:
- final design-system spec;
- final lint/enforcement plan;
- final cutover plan;
- decision log;
- unresolved risks;
- optional T8 results if approved and performed;
- proof that T8 was reverted, if applicable;
- verification matrix;
- final recommendation for separate implementation planning.

## Hard Stops

Stop and request approval before:
- crossing G2;
- crossing G3;
- running optional T8;
- touching production implementation;
- pushing, opening a PR, deploying, or changing main checkout;
- renaming internal/protocol/system identifiers;
- expanding beyond v2 Blend without explicit instruction.
