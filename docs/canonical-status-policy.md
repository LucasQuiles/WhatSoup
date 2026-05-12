# Canonical Status Policy

This document defines how WhatSoup interprets status across the documentation
surfaces tracked by `docs/work-index.{json,md}`.

It exists to keep three things aligned:
- authored `state.md` truth
- scanner behavior
- human expectations when reading `docs/sdlc`, `docs/plans`, and `docs/superpowers`

This policy is metadata-first. It does not require any directory moves.

## Scope

This policy applies to the surfaces indexed by `docs/work-index`:
- `docs/sdlc/active/`
- `docs/sdlc/closed/`
- `docs/sdlc/completed/`
- `docs/plans/`
- `docs/superpowers/plans/`
- `docs/superpowers/specs/`
- `docs/superpowers/handoffs/`
- `docs/superpowers/reviews/`

The dedup side surfaces `docs/duplicates-report.md` and
`.tmup-artifacts/dedup-triage-021.md` are deliberately outside this index.
They are historical evidence and issue-conversion input, not live backlog
truth. A dedup item becomes active work only after it is promoted to a GitHub
issue or to an indexed `docs/sdlc` / `docs/superpowers` artifact with authored
status metadata.

It governs:
- epic-level state resolution
- child artifact status inheritance
- directory bucket semantics
- authoring rules needed to keep the index consistent

## Status Vocabulary

Use these statuses only:

| Status | Meaning |
| --- | --- |
| `active` | Work is genuinely in progress now. |
| `pending` | A unit of work is defined but not yet done. |
| `completed` | Work is done and treated as landed. |
| `closed` | Work is no longer active, but completion is not the intended claim. Use sparingly. |
| `deferred` | Work is intentionally shelved or left unfinished by decision. |
| `unknown` | The scanner could not resolve a trustworthy status from authored metadata. |

**Normalization rules**
- `in_progress` and `in-progress` normalize to `active`.
- `merged` and `complete` normalize to `completed`.
- `shelved` normalizes to `deferred`.
- Free prose does not count unless it appears in an authored status slot defined below.

## Directory Bucket Semantics

Directory placement is history and grouping, not truth.

| Bucket | Meaning |
| --- | --- |
| `docs/sdlc/active/` | The epic is still live. |
| `docs/sdlc/closed/` | The epic is no longer live, but may be completed, deferred, or simply historically closed. |
| `docs/sdlc/completed/` | The epic is intended to be complete unless authored metadata says otherwise. |
| `docs/plans/` | Legacy plan bucket. Entries here do not get an implied status. |
| `docs/superpowers/plans/` | Planning surface, not execution truth by itself. |
| `docs/superpowers/specs/` | Design intent, not execution truth by itself. |
| `docs/superpowers/handoffs/` / `reviews/` | Supporting artifacts, not canonical execution truth by themselves. |

**Rule:** directory placement is always fallback metadata. It must not override explicit authored status in `state.md`, bead manifests, or artifact-local markers.

## Resolution Model

There are two separate resolution problems:
- the status of an epic
- the status of a child artifact inside or adjacent to that epic

They do not use the same precedence ladder.

### Epic-Level Precedence

For an epic `state.md`, precedence is:

1. explicit `**Status:** ...` field in `state.md`
2. `Phase Log` table status, but only from the dedicated status cell
3. directory bucket fallback

**Rules**
- `state.md` wins over directory placement.
- `Phase Log` is only valid when the parser is reading the standalone status cell, not incidental prose in notes.
- A successor epic must not be represented as an `active` row inside the prior epic’s `Phase Log`.
- If an epic is in `closed/` or `completed/`, its `state.md` should say so explicitly.

### Child-Artifact Precedence

For beads, docs, handoffs, reviews, plans, and specs, precedence is:

1. `Bead Manifest` row in the parent `state.md` when the child is explicitly listed there
2. artifact-local `Status:` / `**Status:**` marker
3. inherited parent `state.md` explicit status
4. inherited parent `Phase Log` status when no stronger source exists
5. generic content markers such as archived/superseded wording
6. directory fallback

This is why `work-index` records row-level `status_source` values such as:
- `bead-manifest`
- `body-marker`
- `state-md-status`
- `phase-log`
- `content-marker`
- `directory`

**Rules**
- Child-local truth beats parent inheritance, except for explicit `Bead Manifest` rows, which are authoritative for the listed work unit.
- Do not auto-promote a bead to `completed` just because its epic is complete.
- Parent `active` should not spread blindly to sibling docs when those docs have their own explicit markers or are clearly historical evidence.
- If a bead file exists but its parent epic has no `state.md` (or the bead ID is absent from the Bead Manifest), resolve via body-marker, then directory, then `unknown`. Do not invent a status.
- If no trustworthy authored source exists, return `unknown`, not a guessed status.

## Authoring Rules

### 1. Closing or moving an epic

Whenever an epic moves between `active/`, `closed/`, or `completed/`:
- update the `**Status:**` field in `state.md`
- update any self-references to the old path prefix
- ensure `Phase Log` does not still claim an open execution phase unless that is intentional

**Atomicity:** perform the directory move and the state.md Status rewrite in the same commit. The scanner's active-sibling damping rule (§Scanner Rules) suppresses `active` propagation to sibling files when the epic's declared status disagrees with its directory bucket. That is the correct steady-state behavior, but it means a mid-transition commit where the directory has moved but the state.md still says `active` will briefly classify sibling docs via their own body-marker or fallback instead of inheriting from the parent. The directory-status-mismatch inconsistency is still flagged, but operators should not rely on sibling-row statuses during a transitional commit.

### 2. Successor epics and follow-on work

If a closed/completed epic spawns future work:
- use a dedicated `## Follow-on` section
- do not append a `Phase Log` row with status `active`

The old epic stays closed/completed; the successor gets its own epic record.

### 3. Deferred work

If work is intentionally shelved:
- write `**Status:** deferred`
- say why it was deferred
- keep unfinished beads as `pending` if they are genuinely unimplemented

`deferred` is an authored decision, not a directory inference.

### 4. Missing source documents

When a `state.md` references an external plan/spec/handoff that was never committed:
- replace the fake file path with italic prose describing the source
- do not leave backticked non-existent paths in the file

Backticks imply a concrete on-disk reference and will be treated that way by tooling.

### 5. Plans, specs, handoffs, reviews

For `docs/plans` and `docs/superpowers/*` artifacts:
- absence of an explicit marker means `unknown`
- do not infer `completed` or `active` from the filename or parent directory alone

## Scanner Rules

The scanner should implement the following:
- match status markers with word boundaries, not loose substring matches
- recognize `deferred`, `shelved`, `in_progress`, and `in-progress`
- parse `Phase Log` status from the status column only
- extend mismatch detection to `docs/sdlc/completed/` when authored status is non-completed
- treat directory placement as fallback only

## Known Exceptions and Non-Bugs

These are current repo truths, not scanner defects:

- `docs/sdlc/closed/mark-read-api-20260408/` has a `completed` epic state with `pending` beads. The scanner should report that mixed state honestly.
- `docs/sdlc/active/agent-layer-hardening-20260405/` is the only genuinely active epic at present.
- `docs/plans/` and many `docs/superpowers/*` files remain `unknown` until they are explicitly normalized; that is expected.

## Operational Expectations

- Regenerating `docs/work-index` must refresh generation metadata so `git_head` and timestamps match current `HEAD`.
- Any future inconsistency reduction should prefer metadata repair over directory churn.
- Regrouping work should happen only after this policy and the synthesized program view stay stable under regeneration.

## Current Summary

As of the integrity pass merged in `bfbbedb`, the intended repo shape is:
- one genuinely active SDLC epic
- completed and deferred SDLC history preserved in place
- `docs/plans` as a legacy bucket to drain later
- `docs/superpowers/*` as planning/design/support surfaces whose statuses remain `unknown` unless explicitly authored
