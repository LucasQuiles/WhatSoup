# SDLC State: Add Line Wizard

## Metadata
- **Task ID:** add-line-wizard-20260401
- **Created:** 2026-04-01T24:00:00Z
- **Complexity:** Complex (backend API + SSE streaming + multi-step UI + systemd provisioning + auth flow)
- **Phase:** 2 — Plan
- **Status:** Active
- **Spec:** `docs/superpowers/specs/2026-04-01-add-line-wizard-design.md`

## Bead Registry
| ID | Title | Layer | Status | Depends |
|----|-------|-------|--------|---------|
| B01 | POST /api/lines — instance creation endpoint | Backend | pending | — |
| B02 | GET /api/lines/:name/auth — SSE QR stream | Backend | pending | B01 |
| B03 | GET /api/lines/:name/exists — name uniqueness check | Backend | pending | — |
| B04 | AddLineButton component (green expand) | Frontend | pending | — |
| B05 | WizardShell + stepper + navigation | Frontend | pending | — |
| B06 | IdentityStep — name, type, admin phones | Frontend | pending | B05 |
| B07 | ModelAuthStep — conditional model/key config | Frontend | pending | B05 |
| B08 | ConfigStep — collapsible sections | Frontend | pending | B05 |
| B09 | ReviewStep — summary with edit-back | Frontend | pending | B06, B07, B08 |
| B10 | LinkStep — QR display via SSE | Frontend | pending | B02, B05 |
| B11 | TagInput shared component | Frontend | pending | — |
| B12 | CardSelector shared component | Frontend | pending | — |
| B13 | CollapsibleSection shared component | Frontend | pending | — |
| B14 | Integration test — full create + auth flow | Test | pending | all |

## Wave Plan
- **Wave 1 (parallel):** B01, B03, B04, B05, B11, B12, B13 — infrastructure + shared components
- **Wave 2 (parallel, after Wave 1):** B06, B07, B08 — wizard phase forms
- **Wave 3 (after Wave 2):** B02, B09, B10 — SSE backend + review + QR display
- **Wave 4:** B14 — integration testing
