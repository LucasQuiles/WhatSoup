# SOUP v3 Program Directives — canonical operating guidance

This is the single in-repo home for the operating directives, hard gates, execution
discipline, and creative bar governing the SOUP Design System v3 implementation
program. Every agent dispatched into this program reads this file before starting;
the integrator re-reads it at every Gate 0 preflight, before every dispatch wave, and
after every origin merge. If guidance here conflicts with a slice investigation
packet, the packet wins for that slice and the conflict gets recorded in the
execution log.

## 1. Standing operator directives

- Fan out agent teams against the remaining burn-down and new findings; one team per
  objective, file-disjoint lanes only.
- Monitor, manage, redeploy, and clean up continuously — no staleness, no stagnation.
- Check, re-check, and validate completed work: properly tracked, committed, merged.
  Integrator verifies every agent claim independently before committing.
- Own the whole surface. No "deferred / pre-existing" framing — triage everything to
  an action, a debt entry with owner and expiry, or an explicit user decision.

## 2. Hard gates (binding, no exceptions without explicit user approval)

- No push, PR, deploy, main-checkout edit, or protocol rename. The push gate also
  requires the commit-author email resolution at squash (operator instruction; the
  address itself stays out of committed text).
- Protected identifiers never flip: the `whatsoup:` localStorage prefix,
  `/run/whatsoup/` socket paths, instance data paths, the `mcp__whatsoup__*`
  namespace, `WhatSoupError`, the ConfigStep "via WhatSoup" system prompt, and
  systemd/launchd unit names.
- No `git stash` in this multi-worktree repo. Shelving requires an explicit recorded
  note and is avoided wherever possible.
- No destructive cleanup commands (`git clean`, `checkout --`, `reset --hard`).
- Spec (`03-spec/`) is the design authority. Do not reopen locked design direction;
  spec conflicts route to a debt entry plus a user decision.

## 3. Execution discipline

- **A0 investigation gate:** every implementation slice is blocked until its
  investigation packet exists (files classified, fixtures, test plan, reliability
  answers, responsive note, enforcement classification, strong-claim audit, rollback)
  with verdict Ready or Ready with Constraints. Constraints are binding.
- **Worktree contract:** implementation worktree and design-docs worktree are
  separate. Docs commit on the design branch and merge into the implementation
  branch from the implementation worktree (`git -C <impl> merge <design-branch>`);
  merging while sitting in the design worktree is a self-merge no-op trap.
- **Integrator commits:** agents never commit. The integrator stages by explicit
  path only — never `git add -A` (background lanes deposit files) — and verifies
  every claim (grep proofs, counts, test deltas) before committing.
- **Battery per commit:** typecheck via project config AND the build (the build
  catches optional-field strictness the bare typecheck misses), lint, full console
  suite, theme parity, shadow ratchet (counts fall-only; baseline updates ride the
  same commit with justification), `git diff --check`. Origin merges absorbed
  promptly; resolution rule for conflicts with migrated surfaces is "our structure,
  their data," and `git ls-files -u` plus a whole-tree marker scan proves completion.
- **Test integrity:** real terminal assertions only; no stderr masking in test
  commands; fragment edits on test files can fail hook parsing — append complete
  describe blocks via heredoc instead.
- **Tooling traps:** never pipe a dev server through `head` (SIGPIPE kills it and
  fakes a crash); the CDP browser harness cannot do trusted keyboard QA (false
  positives — trusted-event proof belongs to the D7 lane); keep browser-agent briefs
  to five checks or fewer, screenshots only.

## 4. Creative bar (binding for every remaining visual checkpoint)

Serious industrial polish with Apple-level consistency: restrained contrast, durable
primitives, status-first color, token discipline, operator scan paths, mode parity
(light mode designed first-class, never inverted dark), motion restraint, coherent
component anatomy. No generic SaaS-template drift, no decorative motion, no
Dribbble-only fantasy patterns — consult the reject list in
`../01-research/reference-library.md` §10. Per-screen polish passes apply the
operator-attention criteria: what the operator notices first, what recedes, color
reserved for meaning, both themes reviewed as designed.

## 5. Phase-era add-on dispositions (2026-06-12)

Five operator add-on prompts (creative polish bar; reference library; review
domains; enforcement/DRY/SSOT/SOC discipline; plan finalization) were audited after
the design phase closed. Findings: the demanded artifacts already exist —
`01-research/reference-library.md` (ten categories plus the Design Direction Signals
synthesis in `research-digest.md`), the `00-inventory/` registers including
duplication and IA/workflow reviews, microcopy voice in `03-spec/brand.md`,
per-component States sections, the lint lifecycle in `04-enforcement/lint-plan.md`,
and the waiver/exception registry. Binding residue: the operator-attention criteria
above, a consolidated state-taxonomy index page (lands with the C3 stage), and the
maturity-scorecard axes folded into the final closeout rubric. Nothing else is
actionable without reopening locked direction via a user gate.

## 6. Artifact map (repo-relative SSOT pointers)

| Truth | Home |
|---|---|
| Design authority | `docs/design-system/03-spec/` (tokens-v3, color, motion, brand, components/) |
| Locked direction reference | `docs/design-system/02-directions/iterations/v2.html` |
| Research + reject list | `docs/design-system/01-research/{reference-library,research-digest}.md` |
| Inventories and registers | `docs/design-system/00-inventory/` |
| Slice packets and evidence | `docs/design-system/06-implementation/*-{investigation,evidence}.md` |
| QA law per slice | `docs/design-system/06-implementation/qa-hardening.md` |
| Debt | `docs/design-system/06-implementation/design-debt-register.md` |
| Conformance | `docs/design-system/06-implementation/conformance-manifest.md` |
| Program history | `docs/design-system/06-implementation/execution-log.md` |
| Enforcement lifecycle | `docs/design-system/04-enforcement/lint-plan.md` |
| Waivers/exceptions | `console/eslint-waivers.yaml` |
| Cutover + branding | `docs/design-system/05-cutover/{cutover-plan,branding-touchpoints}.md` |
| Working checklist | operator-local plan file (Claude plans directory); position block updated after every landed slice |

## 7. Alignment review cadence

- Integrator: re-read this file at every Gate 0, before each dispatch wave, after
  every origin merge, and at every stage transition; record drift between this file
  and practice in the execution log and fix whichever is wrong.
- Dispatched agents: read this file plus the slice packet before writing anything;
  report any directive/packet conflict as BLOCKED rather than improvising.
- Stage E closeout audits this file against the actual program record as one of its
  evidence-completeness checks.
