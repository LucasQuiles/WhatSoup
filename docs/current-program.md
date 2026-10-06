---
type: Plan
status: active
---

# Current Program — WhatSoup

Start here to find current work. This page routes readers to the record that owns
each fact; it does not keep a second issue queue or copy generated status counts.

## What is true now

[The work index](work-index.md) lists the planning artifacts in its declared scope.
Check its generation timestamp and each artifact's authored status before acting.
It does not include every local worktree, untracked plan or operational handoff.
An empty active section would not prove that the project has no active work.

Git and GitHub own delivery state. A plan marked complete does not prove that its
code is merged, deployed or verified in the running application.

## Find the next action

| Need | Open or inspect | What it establishes |
|---|---|---|
| Understand the application | [README](../README.md), then [project map](project-map.md) | Usage, subsystem boundaries and implementation paths. |
| Follow contributor rules | [AGENTS.md](../AGENTS.md) | Shared commands, conventions and verification requirements. |
| Find active plans and specifications | [Work index](work-index.md) | Authored active, pending, deferred and unknown planning records, with their source paths. |
| Find current implementation and review | `git status -sb`, `git worktree list`, `gh pr list --state open` | The checkout, parallel work and open pull requests. Read the relevant PR before duplicating work. |
| Find requirements and blockers | `gh issue list --state open`, then the relevant issue and linked plan | Current requested outcomes, owners and dependencies. Reconcile these with source and local work. |
| Verify completion | [Objective tracking](runbooks/objective-tracking.md) | Required code, test, merge and runtime evidence; unresolved checks stay explicit. |
| Understand a status label | [Canonical status policy](canonical-status-policy.md) | How authored metadata and generated index rows are interpreted. |

A useful handoff names its objective, owner, branch or worktree, requirement,
implementation boundary, verification, delivery state and next condition.
Keep that detail in the existing plan or PR. Private deployment and machine-local
evidence stays in its private operational record, with an explicit owner.

## Specifications, reference and history

Use the [project map](project-map.md) to choose the relevant subsystem's
specification or runbook. Specifications describe required behavior; plans describe
the work to achieve it. Neither replaces source or runtime evidence.

Completed and superseded plans remain discoverable through the work index and Git
history. The [June 20 sweep](sweep-report-2026-06-20.md) preserves its dated inventory
and disposition evidence; its counts are not current project state.

## Keep this route small

Update this page when navigation, ownership boundaries or the operating model
changes. Routine fixes do not require an edit here.

When an indexed artifact changes, update its authored status and regenerate
`docs/work-index.*` with `npm run work-index:regen`; verify with
`npm run guard:work-index`. Do not hand-edit generated rows or copy their counts
into this page. Keep unfamiliar or unverified work visible as unknown.

For new or removed tracked internal documents, follow
[the publication audit](publication-audit.md). Link authoritative specifications
instead of copying them. Plain Markdown remains usable without optional tooling;
no corpus-wide frontmatter migration or additional service is required.
