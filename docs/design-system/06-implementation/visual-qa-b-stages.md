# Visual QA Matrix — B-stage live checkpoint round (2026-06-12)

Shared evidence source for the b3-wave2, b3-wave3, b4, and b5 evidence packets.
Live QA against the dev server at localhost:5173 (mock data), real Chromium via CDP,
1440x900 unless noted, both themes where stated. Screenshots under `/tmp/soup-qa2/`
and `/tmp/` (session-scoped; paths recorded here for the packet snapshot, not as
durable artifacts).

Verdict vocabulary: PASS / FAIL / INCONCLUSIVE (with reason). Environment-
INCONCLUSIVE means the check could not be exercised against mock data or the
dev server, not that the surface failed; compensating evidence is named inline.

## Matrix

| # | Surface / check | Wave | Result | Evidence |
|---|---|---|---|---|
| 1 | Inbox three panes at 1440x900 (~268/~860/~312), meta + timestamps + log time lane legible mid-gray, both themes (DD-8 promotion) | b4 / dd8 | PASS (5/5 sub-checks) | /tmp/check1-1440x900-FINAL.png, /tmp/check2-1024x768.png, /tmp/check4-logs-stream.png, /tmp/check5-post-toggle.png |
| 2 | Inbox contact pane collapses at 1024x768 per collapse rule | b4 | PASS | /tmp/check2-1024x768.png |
| 3 | Composer Text/Media + Recurring/One-shot render as joined segmented controls (C-B3W2-3) | b3w2 | PASS | /tmp/soup-qa2-check-b.png |
| 4 | ConfigEditDialog opens from LineDetail and renders on Modal | b3w2 | INCONCLUSIVE (environment) — no mock line carries a `config` field (`grep "config:" console/src/mock-data.ts` = zero hits), so the `{line.config && …}` gate at LineDetail.tsx:304 never opens the dialog against mock data. Compensating evidence: shell is the same Modal primitive visually confirmed in rows 3/5/6; behavior pinned by the 57-test jsdom suite. Fixture improvement filed (see Notes). | — |
| 5 | GroupDetailModal anatomy: avatar, two-line header (title + participants), Info/Participants/Settings tab strip under header, calm labeled-field density, labeled X close | b3w3 | PASS | /tmp/soup-qa2-check-a.png (dark) |
| 6 | GroupDetailModal in light theme designed-first-class (legible text, correct surfaces, no inverted-dark artifacts) | b3w3 / theme parity | PASS | /tmp/soup-qa2/gdm-light.png — verified frame: white modal, green RA avatar, two-line header, tab strip, kv fields, invite-link + Copy |
| 7 | LineDetail light theme designed-first-class; DD-8 Polling badge promotion visible; provider error fail-visible | b3 / dd8 | PASS | /tmp/check1-config-dialog-v2.png (salvaged frame from first dialogs lane) |
| 8 | AddLineWizard open (dark): Modal shell, 5-step strip (Identity active in accent, later steps muted), Name field, Cancel/Next footer | b3w4 | PASS | /tmp/check1-wizard-open.png, /tmp/soup-qa2/wizard-dark-step1.png |
| 9 | Wizard advance Identity→Link (step strip marks step 1 done) | b3w4 | INCONCLUSIVE (environment) — advancing creates the instance via `api.createLine`, which returns 502 against the dev server (no backend). Positive finding inside the failure: the modal shows a fail-visible error banner with form state preserved (name + phone pill intact, Next still enabled). Step transitions are pinned by the 23-test wizard jsdom suite. | /tmp/soup-qa2/wizard-502-fail-visible.png |
| 10 | Wizard in light theme designed-first-class | b3w4 / theme parity | PASS | /tmp/soup-qa2/wizard-light.png — verified frame: white surface, legible step strip, clean type cards, labeled fields |
| 11 | Wizard discard confirm on X close (save-unlinked copy, no deletion promise) | b3w4 | PASS — observed branch (pre-instance, nothing provisioned): title "Discard changes?", body "You have unsaved configuration. Closing the wizard will discard all changes.", Cancel / Discard (danger) — accurate for that branch. The post-instance option-α branch ("Abandon new line?" + primary "Save and close" + keep-unlinked copy, AddLineWizard.tsx:403-411) is unreachable live (row 9's 502 gap) but pinned by jsdom: "Escape after creation raises abandon confirm" + the option-α no-deleteLine assertion. Copy verified against source directly. | /tmp/soup-qa2/wizard-discard-confirm.png (confirm caught mid-enter; copy claims rest on source + lane observation) |
| 12 | Wizard at 390x844: modal fits, step strip usable, footer reachable | b3w4 / dd18-class | PASS — modal 358px wide in the 390px viewport, zero horizontal overflow (scrollWidth == clientWidth == 356); step strip wraps to two legible rows (1-3 / 4-5); type cards three-across; Name full-width; Cancel (86×32) and Next (75×32) visible well inside the viewport (≥24px target floor); no clipping. "Add Line" toolbar button keeps icon + full label at this width. | /tmp/soup-qa2/wizard-390x844.png (verified frame) |
| 13 | B5 background inert behavioral: nav theme toggle does not fire while a modal is open (#root inert) | b5 | PASS (by-design behavior observed live) — toggle click suppressed while GroupDetailModal open; fires normally after close. Complements tests/browser/b5-inert-toast.test.tsx focus-refusal proof. | observed in qa-dialogs-b transcript; gdm-light.png shows post-close toggle applied |
| 14 | B5 toast/exit motion | b5 | covered by browser suites, not re-proven manually — browser 93/93 + browser-motion 3/3 (animated dwell) are the canonical proof | tests/browser/b5-inert-toast.test.tsx, tests/browser-motion/ |

## Notes and findings routed onward

- **Microcopy finding (C3):** when the backend error carries no message body, the wizard
  error banner renders `API 502:` with a dangling colon and empty detail
  (/tmp/soup-qa2/wizard-502-fail-visible.png). Error-surface copy should omit the colon
  or supply a fallback phrase when detail is empty. Routed to the C3 consolidated pass.
- **Fixture improvement (C3, optional):** add a `config` field to one MOCK_LINES entry
  so ConfigEditDialog becomes reachable in live QA (row 4). Not a defect; the dialog is
  gated correctly by `{line.config && …}`.
- **Environment gap:** mock dev server has no backend; any flow that POSTs
  (createLine) is unreachable past the request. Affects rows 4 and 9 only.
- **Harness lesson (binding for future QA):** two concurrent browser-QA subagents share
  one Chrome instance and fight each other's navigation — the first dialogs lane and the
  wizard lane each burned most of their context on cross-agent navigation interference.
  Browser QA lanes are SERIALIZED from now on (one lane at a time). Also: the separate
  `screenshot` action dispatches page-level mouse events that can hit nav links in this
  app — use the per-action auto-capture PNGs instead.
- **Branding note:** nav still shows the WhatSoup wordmark and "Soup Kitchen" label in
  every frame — expected; the C4 branding flip has not run yet.

## Verdict

Live visual QA round: **PASS WITH ENVIRONMENT CAVEATS** — 11 PASS, 2 environment-
INCONCLUSIVE (rows 4 and 9) with named compensating jsdom/browser-suite evidence,
1 delegated to the committed browser suites (row 14). No new visual defects found;
one microcopy nit (dangling-colon error banner) and one fixture gap (mock `config`)
routed to C3. This matrix gates and feeds the b3-wave2, b3-wave3, b4, and b5
evidence packets.
