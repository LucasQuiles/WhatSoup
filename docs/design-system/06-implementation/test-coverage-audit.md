# Console Test-Coverage Audit — SOUP v3 (jsdom suite, v8 provider)

Read-only audit of `tests/console/` coverage over `console/src/**`. Paths are
repo-relative (implementation branch `feat/soup-v3-foundation`).

## Method and tree state

- Command: `npx vitest run --pool=forks tests/console --coverage.enabled
  --coverage.provider=v8 --coverage.include='console/src/**'
  --coverage.reportOnFailure` (the `reportOnFailure` flag is required: vitest 3.2.6
  suppresses report emission on any test failure by default, and the tree currently
  carries one failing in-flight test — see below).
- Evidence anchor: HEAD `ca799b4f`, with an uncommitted B3 wave-3 lane in flight
  (modified `GroupDetailModal.tsx`, `UpdateModal.tsx`, `Toolbar.tsx`; untracked
  `tests/console/group-detail-modal.test.tsx`). Numbers for those two dialogs are a
  snapshot of mid-slice work, not a settled baseline.
- Suite result at audit snapshot: 135 files, 2192 passed / 1 failed — the audit ran
  against a mid-flight dialog-migration tree. RESOLVED at integration: the landed
  suite passes in full (2,193+) and the failure
  (`group-detail-modal.test.tsx:372`, tab `aria-controls` returns null) belongs to the
  in-flight B3 wave-3 lane (the test file is untracked); it is that lane's defect to
  close before its evidence packet, not a regression in landed work.
- Provider present: `@vitest/coverage-v8` is installed at the root; no install needed.
- `tests/browser/` exists (`smoke.test.tsx`) and proves trusted-event mechanics
  (real Tab focus, `:focus-visible`, `isTrusted` clicks) — the landing zone for every
  jsdom-impossible item below, per the D7 survey (verdict GO).

## Summary table (statements / branches, v8)

| Area | Files | Statements | Branches | Functions |
|---|---|---|---|---|
| components/primitives | 12 | 99.1% | 95.6% | 100% |
| hooks | 12 | 99.0% | 95.5% | 100% |
| components/shared | 3 | 100% | 95.9% | 94.1% |
| components/line-detail | 22 | 92.1% | 89.9% | 72.1% |
| components (top-level) | 36 | 88.7% | 78.9% | 81.3% |
| components/wizard | 8 | 82.9% | 86.1% | 63.9% |
| lib | 23 | 85.5% | 90.4% | 71.9% |
| pages | 4 | 61.5% | 66.1% | 36.2% |
| root (App, main, mock-data, types) | 4 | 82.6% | 87.8% | 39.5% |
| **Total console/src** | **124** | **85.8%** | **86.0%** | **73.3%** |

Reading: the design-system contract surfaces (primitives, hooks, shared pickers) are
where the program demands near-completeness, and they are near-complete. The deficit
concentrates in two not-yet-migrated pages (Ops, Inbox), one security surface
(UnlockScreen), and presentation/error-path branches on a handful of app components.

## Prioritized gaps

### SHOULD-COVER-NOW (writeable today in jsdom, no slice dependency)

1. **`console/src/components/UnlockScreen.tsx` — 4.3% statements, effectively untested.**
   This is the B1 console-lock closure deliverable: the production console starts
   locked and this form is the only way in. Untested: submit happy path, error
   rendering on rejected token, busy-state double-submit gating, whitespace-token
   guard (lines 9–58). Companion gap: `console/src/hooks/use-console-session.tsx`
   lines 27–32 — the probe-failure catch that maps 401/network errors to `locked` is
   the one uncovered path in an otherwise-100% hook
   (`use-console-session-lock.test.tsx` only mocks a successful initial probe).
   Write: new `tests/console/unlock-screen.test.tsx`; extend
   `tests/console/use-console-session-lock.test.tsx` with a rejected first probe.
2. **`console/src/pages/Ops.tsx` — 7.7% statements, 0% functions; the page never
   mounts in any test.** `tests/console/ops-actions.test.ts` covers only the pure
   helpers it imports. Untested: the whole render (lines 36–322), restart/stop/delete
   confirm flows, relink modal wiring, log-level filtering, `logLevelTone` (line 30),
   and the only call site of `statusWashClass`
   (`console/src/lib/status-severity.ts:25`, itself uncovered — status-first color is
   a program pillar). Ops already adopted the LogStream primitive, so this is a
   migrated surface with zero behavioral proof. Write: new
   `tests/console/ops-page.test.tsx` (mount with mocked `use-fleet` hooks; assert
   degraded/confirm/filter behavior), plus `statusWashClass` cases in a small
   `status-severity` describe block (could live in `tests/console/nav-status.test.ts`
   beside its sibling helpers or a new file).
3. **`console/src/components/FeedCard.tsx` — 52.9% branches; every status-presentation
   mapper is uncovered.** `connectionTone` (line 116), `connectionPresentation`
   (line 168), `toolErrorPresentation` (line 223), `sessionPresentation` (line 234),
   `importPresentation` (line 257), plus the copy-content action (line 426). These are
   exactly the error/degraded-state presentations the program treats as first-class;
   two test files exist (`feed-card.test.ts`, `feed-card-render.test.tsx`) but neither
   feeds connection/tool-error/session/import event shapes through. Write: extend
   `tests/console/feed-card.test.ts` with one case per mapper per tone.
4. **`console/src/pages/SoupKitchen.tsx` — 73.8% branches; the error-state retry lane
   is dark.** Uncovered: `onRetry` handlers for the KPI/chart/feed error panels
   (lines 647–653, 669–677, 693–701, 308–311), the chart-section degraded block
   (lines 472–516), and a drawer `onClose` (line 1023). The page is the flagship
   migrated surface (80 tests) but its empty/error/retry branches — first-class states
   per spec — are asserted nowhere. Sibling gap in the same family:
   `console/src/components/ActivityFeed.tsx` at 28.3% branches (restart/stop/confirm
   handlers, lines 108–139). Write: extend `tests/console/soup-kitchen.test.tsx`
   (force query errors, assert Retry invalidates) and a handler block in
   `tests/console/feed-card-render.test.tsx` or a new `activity-feed.test.tsx`.
5. **`console/src/hooks/use-dismissable.ts` — two real dismissal/stack branches
   uncovered (88.9% branches).** (a) Lines 170–173: Tab inside an overlay with zero
   focusable children must `preventDefault` (trap holds on an empty container) —
   never exercised. (b) Line 240: the outside-click handler's stacking guard
   (`peekTopmost() !== stableClose`) — Escape single-fire IS tested, but the
   equivalent "one outside click closes only the topmost of two stacked dismissable
   overlays" contract is not. (c) Line 177: the Shift+Tab recovery arm when focus has
   escaped the container. Write: extend `tests/console/primitives-modal.test.tsx`
   (which already hosts the stacked-Escape proof) with these three cases. The SSR
   `typeof document` guards (lines 142, 149, 235) are not reachable under jsdom —
   accepted, see below.
6. **Primitive prop/branch nits (cheap, keeps the contract surfaces at
   near-complete).** All named, all one-test-each:
   - `Pill.tsx:165` removable variant with non-string children (falls back to
     `Remove ` with an empty label — arguably a fail-visible naming check) and
     `Pill.tsx:170` `count` chip on the removable variant (count is tested on the
     plain variant only). Extend `tests/console/primitives-pill.test.tsx`.
   - `Button.tsx:80` `iconEnd` never rendered in any test. Extend
     `tests/console/primitives-button.test.tsx`.
   - `Tabs.tsx:86` the `Tab must render inside <Tabs>` guard throw. Extend
     `tests/console/primitives-tabs.test.tsx`.
   - `Table.tsx:133` `TableHeaderCell` sort click with no `sortKey`/`onSort` (inert
     guard); `Table.tsx:236/241` interactive-row `onClick`/`onKeyDown` passthrough
     arms. Extend `tests/console/primitives-table.test.tsx`.
   - `Popover.tsx:164` `placement="span"` min-width sizing branch (an exported prop
     of the canonical picker primitive). Extend
     `tests/console/primitives-popover.test.tsx`.
   - `LogStream.tsx:152` expanded detail bed when `entry.component` is present.
     Extend `tests/console/primitives-log-stream.test.tsx`.
7. **`console/src/components/AddLineWizard.tsx` — 46.9% branches; `validateStep`
   (line 94) is uncovered.** The per-step gate that decides whether Next advances is
   the wizard shell's core logic; individual step components are well-tested but the
   shell's validation, step transitions (lines 193–250), and completion wiring are
   not. Write: extend the wizard shell coverage in a new
   `tests/console/add-line-wizard.test.tsx` (no existing shell-level file;
   `wizard-step-shell.test.tsx` covers the `WizardStep` chrome only).

### COVER-IN-NAMED-SLICE (the surface is owned by scheduled work; testing now would churn)

- **`console/src/pages/Inbox.tsx` (29.1% statements, 38.7% branches) — B4.** The
  existing `inbox-page.test.tsx` is deliberately a structural/class-contract harness
  (its header says so). All behavior is uncovered: send pipeline with error path
  (lines 149–180), load-older pagination (128–144), save-contact flow (182–200),
  chat selection and the composer (240–593). B4's packet already owns the chat-list
  keyboard contract (DD-17) and the pane-collapse work (DD-18r); behavioral tests
  should land as B4 acceptance evidence against the post-migration DOM, not against
  the legacy structure. Same disposition for the `MessageContent.tsx` media-branch
  remainder (64.8% branches; lines 63–65, 171–173, 203–207) and `MessageBubble`
  hover-card behavior — both inside B4's surface.
- **`console/src/components/line-detail/GroupDetailModal.tsx` (69.1%) and
  `console/src/components/UpdateModal.tsx` (78.6% branches) — B3 wave 3, in flight
  now.** The dirty tree and the new untracked test file are that lane's work product;
  its packet requires invite-link, participant-management, and settings-seg coverage.
  Audit both numbers again at wave-3 evidence acceptance, and hold the lane to fixing
  its failing `aria-controls` test rather than weakening it (qa-hardening
  signal-weakening audit applies).
- **`console/src/components/wizard/ConfigStep.tsx` (64.4%) — DD-21r remainder.** The
  large uncovered ranges (750–945: advanced sections; 187–243: tab-switch handlers)
  sit on the hand-rolled tablist that DD-21r migrates onto the Tabs primitive
  (C2/C3 per the register). Keyboard-contract tests per site are the register's own
  expiration condition — write them in that slice against the primitive, not against
  the legacy markup.
- **`console/src/pages/LineDetail.tsx` (47.5% branches) — C3 per-screen polish.**
  Uncovered: header action handlers (restart/stop/relink onClick wiring, lines
  144–187), dialog open/close plumbing (291–319), and the degraded header block
  (87–116). LineDetail gets a C3 polish pass (DD-8 essential-text corrections list
  names it); behavioral handler tests should ride that slice's evidence.
- **`console/src/lib/api.ts` function coverage (44.1%) — partially B3/B4-owned.** The
  uncovered functions are thin fetch wrappers whose group-management members
  (createGroup, updateGroupSettings and peers, lines 477–536) are exercised by the
  in-flight wave-3 dialog tests, and whose message/contact members (sendMessage,
  saveContact, markRead) belong to B4. The shared error-normalization paths
  (lines 121–126, 167–168, 239–241) are worth a direct unit case now if cheap, but
  the wrapper-by-wrapper remainder should fill organically as the owning slices land.

### ACCEPTED-GAP (with reason)

- **`console/src/main.tsx` (0%).** Browser entry bootstrap (root mount, router); not
  meaningfully testable in jsdom and proven by the dev-server/build battery and the
  browser lane. No action.
- **`console/src/types.ts` (0 statements).** Type-only module; v8 reports it empty.
  Not a gap.
- **SSR guards in `use-dismissable.ts` (lines 142, 149, 235) and the non-portal
  fallback in `Popover.tsx:226–228`.** `typeof document === 'undefined'` arms are
  unreachable under jsdom by construction. Exclude from any future threshold
  arithmetic rather than chase with fake environments.
- **Defensive null-ref arms in primitives** (`Tabs.tsx:53` listRef `?? []`,
  `use-dismissable.ts:47` empty-stack peek, container-null guards at
  `use-dismissable.ts:151/242`): unreachable without contriving broken refs;
  fail-safe by inspection. Documented here so nobody burns time on them.
- **Trusted-event and computed-box proofs** (focus-visible behavior, 24px target
  floor / DD-10, container-query pane collapse, viewport matrices / DD-18r): owned by
  the browser lane — `tests/browser/smoke.test.tsx` already proves the harness can do
  trusted Tab/Enter and `:focus-visible`, and the D7 packet scales it. jsdom coverage
  numbers will never include these; that is correct, not a deficit.
- **`console/src/mock-data.ts` partial coverage (83.6%).** Dev fixture module; covered
  incidentally. No targeted tests warranted.

## Coverage ratchet proposal

Recommendation: adopt a **per-directory threshold gate, wired but report-only until
D6**, mirroring the lint shadow-ratchet design (counts fall-only, baseline updates
ride the slice commit that justifies them).

- Mechanism: vitest supports glob-keyed `coverage.thresholds` natively. Add to the
  root `vitest.config.ts` coverage block (or a dedicated `vitest.coverage.config.ts`
  so the default battery's runtime is untouched):
  - `console/src/components/primitives/**`: statements 98, branches 94
  - `console/src/hooks/**`: statements 97, branches 93
  - `console/src/components/shared/**`: statements 98, branches 93
  - `console/src/lib/**`: statements 84, branches 88
  - no global threshold, and no thresholds on `pages/**`, `wizard/**`, or top-level
    `components/**` yet — their numbers are owned by named slices (B3w3, B4, C3) and
    gating them now would either freeze incidental lows or invite threshold-lowering
    commits. Each owning slice raises its directory into the gate as part of its
    evidence packet (B4 adds `pages/Inbox`-area thresholds, wave 3 adds the dialog
    tier, and so on).
  - also set `coverage.reportOnFailure: true` and exclude `main.tsx` and `types.ts`
    via `coverage.exclude` so entry bootstrap never distorts directory math.
- Thresholds sit one to two points below current actuals on the contract surfaces:
  the gate catches regressions (a deleted test, a new untested export) without
  demanding ratchet bumps on every incidental refactor. Raising a threshold is cheap
  and rides the commit that raised real coverage; lowering one requires the same
  justification discipline as a lint-baseline bump.
- Activation: enforcement promotion is D6's charter (promotion criteria, waiver
  audit). Run the thresholded config as a separate report-only CI/battery lane now;
  flip it to blocking in the D6 promotion wave alongside the lint ratchet, so the
  program has one enforcement-activation story instead of two.
