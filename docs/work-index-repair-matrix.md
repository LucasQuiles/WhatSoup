# Work Index — Repair Matrix for 12 Inconsistencies

> Companion to `docs/work-index.md`. Captures the disposition decision for each
> inconsistency the scanner surfaced in v5, along with the exact patch applied.

**Source:** `docs/work-index.json.inconsistencies` from the v5 scanner (12 items total).
**Scope:** state.md files only. No sdlc/ tree moves, no code changes.

---

## Disposition categories

| Category | Meaning | Applied to |
|---|---|---|
| `remove-ref` | Dangling ref to a historical doc that was never committed; inline-replace the backticked path with italic prose so the intent is preserved without tripping the scanner. | #1, #2, #3, #4, #5, #10, #11, #12 |
| `retarget` | File still exists at a different canonical path; fix the reference to point there. | #9 |
| `fix-status` | state.md declares a status inconsistent with ground truth; update the state file. | #6 |
| `classify-deferred` | state.md accurately reflects that the work is shelved; add an explicit `**Status:** deferred` so the placement is authored rather than inferred. | #7 |
| `restructure` | state.md data is correct but formatted in a way the scanner misreads; reshape to remove ambiguity. | #8 |

---

## Matrix

| # | From | Ref / Mismatch | Disposition | Patch |
|---|------|----------------|-------------|-------|
| 1 | `docs/sdlc/completed/audit-remediation-20260330/state.md:9` | `docs/audit-2026-03-30.md` | remove-ref | Replace with `_2026-03-30 WhatSoup code audit (source doc not committed; see bead list below for the 28 findings)_` |
| 2 | `docs/sdlc/completed/p0-production-blockers-20260330/state.md:7` | `docs/handoff-2026-03-30-baileys-parity.md` | remove-ref | Replace with `_2026-03-30 Baileys-parity handoff (source doc not committed; findings are inlined in the Beads section below)_` |
| 3 | `docs/sdlc/completed/remaining-hardening-20260330/state.md:8` | `docs/audit-2026-03-30.md` | remove-ref | Inline prose (combined with #4) |
| 4 | `docs/sdlc/completed/remaining-hardening-20260330/state.md:8` | `docs/handoff-2026-03-30-production-hardening.md` | remove-ref | One combined line: `_2026-03-30 WhatSoup code audit (8 open findings) and 2026-03-30 production-hardening handoff (source docs not committed; findings are inlined below)_` |
| 5 | `docs/sdlc/closed/add-line-wizard-20260401/state.md:10` | `docs/superpowers/specs/2026-04-01-add-line-wizard-design.md` | remove-ref | Replace with `_2026-04-01 add-line-wizard design (source doc not committed; Bead Registry and Implementation Plan below are authoritative)_` |
| 9 | `docs/sdlc/closed/whatsapp-mcp-features/state.md:56` | `docs/sdlc/active/whatsapp-mcp-features/sp9-broadcast-proof.md` | retarget | Change `active/` to `closed/` (file moved with the epic) |
| 10 | `docs/sdlc/closed/phase3-console-features-20260401/state.md:15` | `docs/plans/2026-04-01-phase3-roadmap.md` | remove-ref | Replace with `_2026-04-01 phase-3 roadmap (source doc not committed; the Bead Registry below enumerates the 10 beads that shipped)_` |
| 11 | `docs/sdlc/closed/design-system-compliance-2026-04-06/state.md:6` | `docs/superpowers/plans/2026-04-06-design-system-compliance.md` | remove-ref | Replace with `_2026-04-06 design-system-compliance plan (source doc not committed; task content below is authoritative)_` |
| 12 | `docs/sdlc/active/agent-layer-hardening-20260405/state.md:23,95` | `docs/superpowers/specs/2026-04-05-phase6-agent-layer-hardening-design.md` | remove-ref (x2) | Both refs replaced with prose noting the phase-6 design doc was never committed; the Bead Manifest in state.md is the authoritative delivered scope |
| 6 | `docs/sdlc/closed/multi-provider-runtime-2026-0404/state.md` | dir=closed vs state.md=active | fix-status | Change header `**Status:** active` → `**Status:** completed` and add `**Closed:** 2026-04-11 via cf0dbf3`. Also change Phase Log `Execute | active` → `Execute | complete`. Git log confirms closure commit. |
| 7 | `docs/sdlc/closed/fleet-charts-20260407/state.md` | dir=closed vs phase-log=active (11 beads pending) | classify-deferred | Insert explicit `**Status:** deferred — Phase 4-Execute was incomplete when the folder was moved to closed/. Beads 01-11 remain unimplemented. Shelved, not finished.` Placement in `closed/` is now authored intent (deferred work kept with history), not mismatch. |
| 8 | `docs/sdlc/closed/whatsapp-mcp-features/state.md` | dir=closed vs phase-log=active (Follow-on row) | restructure | Move the `Follow-on` row out of the Phase Log table into its own `## Follow-on` section describing that Phase 6 continued as its own successor epic. Also add explicit `## Status: completed` header. |

---

## Policy follow-ups implied by this pass

- When closing an epic (moving to `closed/` or `completed/`), update the state.md `**Status:**` field to match. Do not rely on directory placement alone.
- When an epic spawns a successor, document the handoff in a separate `## Follow-on` section — do not append a row to the Phase Log with status `active`, because downstream tooling treats that as unfinished work on the closing epic.
- When a state.md references external documents (specs, handoffs, audits) that were never committed to the repo, document them in italic prose rather than with a backticked path. Backticks signal a concrete file reference; prose preserves the semantic reference without faking disk presence.
- When relocating an epic between `active/` → `closed/` or `closed/` → `completed/`, grep the state.md for self-references to the old directory prefix and update them in the same commit.

These rules, together with the status-precedence order below, form the seed of `docs/canonical-status-policy.md` (next step in the program).

---

## Canonical status precedence (to be formalized next)

1. Epic's `state.md` `**Status:**` field
2. Epic's `state.md` Phase Log table
3. Epic's `state.md` Bead Manifest entry (for bead rows)
4. In-body `**Status:**` marker in the file itself
5. Directory placement (fallback)

Directory placement is history, not truth. When it disagrees with state.md, state.md wins — fix the state.md to match reality, don't move the directory.
