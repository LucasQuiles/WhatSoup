# Agent Operating Procedure (WhatSoup)

An index for agents working in this repo. It does **not** restate methodology —
the skills live globally and are invoked by name. This maps each SDLC phase to
the skill to invoke and the repo command that verifies the work.

> Reuse-first: this repo deliberately owns no `.claude/skills`. The workflow
> family lives in the global superpowers + sdlc-os plugins. Invoke skills by
> name; do not duplicate their content here or in `CLAUDE.md`.

## Phase → skill → verification

| Phase | Invoke (global skill/command) | Verify in this repo |
|-------|-------------------------------|---------------------|
| Understand the ask | `hypothesis-driven` (label evidence observed/inferred/assumed) | — |
| Design a non-obvious change | `brainstorming` → `writing-plans` (spec in `docs/superpowers/specs/`) | spec self-review + user approval gate |
| Before writing new code | `sdlc-reuse`, `deduplicating-functions` (search existing utils first) | `grep`/LSP for existing helpers |
| Implement behavior change | `test-driven-development` (red→green→refactor) | `npm test` (vitest), `npm run typecheck:all` |
| Split / parallelize work | `subagent-driven-development`; `orchestrate-volume` for bulk | review each packet for spec + scope + evidence |
| Delegate externally | `opencode-delegation` | re-read diff + run verify locally; trust nothing unverified |
| Refactor | `sdlc-refactor` (characterize first; touched paths only) | tests green before + after |
| Canonicalize / consolidate | `sdlc-normalize` | `npm run guard:repo` |
| Before claiming done | `verification-before-completion` | see Verification gates below |
| Debug a failure | `systematic-debugging` (don't guess) | reproduce + falsify |
| Commit | `commit` (conventional commits) | pre-commit husky chain (below) |
| Review a handoff | `code-review` | record in `docs/superpowers/reviews/` |

## Verification gates (this repo)

- **Pre-commit (husky):** commit-identity → `guard:repo:staged` (hygiene; blocks
  private labels / emails / local paths) → `guard:publication:staged` →
  `guard:design-system-hygiene` → `guard:node-pin-consistency` →
  `guard:claude-settings` → console lint-staged.
- **Pre-push (husky):** `guard:pre-push` → design metrics/burndown.
- **On demand:** `npm test` · `npm run typecheck:all` · `npm run guard:repo`
  (`--staged` / `--branch-diff` / `--scan-history`) · `npm run guard:lint:src` ·
  `npm run guard:test-integrity` · `npm run guard:boundaries`.
- **Public-repo rule:** no personal email, private instance labels
  (`whatsoup@<name>`), local home paths, or model/AI attribution in tracked text
  or commit messages — the hygiene guard enforces this in code AND commit msgs.

## Conventions

- Plans/specs: `docs/superpowers/{specs,plans}/` · handoffs: `…/handoffs/` ·
  reviews: `…/reviews/`. SDLC beads: `docs/sdlc/{active,in-progress,closed}/`.
- Cross-session notes: `~/LAB/project-state/` (durable; not in-repo).
- Deploy scripts (`deploy/scripts/*.py`) ship via a **sha256-pinned manifest**
  (`whatsoup-bot-errors-deploy.sh`) — they must be self-contained (no `node`, no
  cross-tree `.ts` imports). The `.ts` tools in `scripts/` are dev/CI only.

## Notes

The only named workflow skill absent globally is `verify`;
`verification-before-completion` is its functional equivalent — use that.
