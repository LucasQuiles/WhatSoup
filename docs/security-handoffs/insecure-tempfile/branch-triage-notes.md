# Insecure-tempfile work — adjacent branch triage (owner-gated)

> **Status:** ADVISORY. No branch was created, merged, deleted, or rebased by this work.
> These are owner-decision items surfaced *because of concurrency*, not because they
> are "pre-existing exceptions" — they are simply not this branch's to reconcile.
> **Live state captured:** 2026-06-27, against `origin/main` = `711cf4da0`.
> **This branch:** `feat/insecure-tempfile-impl` (insecure-tempfile resolution + `test.insecure-tempfile` guard).

## Why these are listed here, not actioned

The insecure-tempfile resolution touched only test/tooling/script files and the enforcement
spine (registry, guard, gates). It did **not** touch `src/`. Two adjacent branch sets came up
during live-state verification; both require an owner call because automating them would either
collide with an active lane or destroy unlanded work. Each is recorded with the exact live
measurement so a future agent does not have to re-derive it (but SHOULD re-verify — these
counts drift as `origin/main` advances).

## 1. `fix/health-stale-serialization-f1` — reconcile, do NOT auto-merge

| Field | Value (live, 2026-06-27) |
|---|---|
| merged into main | **NO** |
| ahead / behind `origin/main` | **24 ahead / 1 behind** |
| tip | `860b7dc49` (2026-06-25, SoupBot) — `fix(health): thread model-usability freshness through serializer + heal classifier` |
| active-lane overlap | YES — a live healthcheck worktree is checked out on the sibling branch `fix/healthcheck-credential-keychain-authoritative` (same health functional area) |

**Recommendation:** owner reconciliation, not unilateral merge. It is 24 commits ahead with a
real health-serializer change and sits in the same functional area as an *active* healthcheck
worktree. Merging from here risks colliding with in-flight work on the sibling branch. The
right move is for the owner (or the healthcheck-lane driver) to decide whether
`fix/health-stale-serialization-f1` lands as-is, rebases onto the current healthcheck work, or
is superseded. **Do not delete** — it carries 24 unlanded commits.

## 2. `backup/*` (10 branches) — do NOT prune; unlanded backup/rehearsal work

All ten are **UNMERGED** and carry unique unlanded commits (ahead counts below). They are the
backup / rehearsal / reconciliation snapshots of the `bot-errors` noise-reduction initiative
(dated 2026-06-23 → 2026-06-26). The naming (`backup/`, `rehearse/`, `reconcile/`) signals
intentional safety branches, not abandoned feature branches.

| Branch | ahead / behind main | status |
|---|---|---|
| `backup/feat-bot-errors-noise-reduction-tip-20260626` | 429 / 31 | UNMERGED |
| `backup/<host>-bot-errors-noise-reduction-20260623` † | 429 / 44 | UNMERGED |
| `backup/reconcile/bot-errors-agent-runtime-port-20260623` | 57 / 23 | UNMERGED |
| `backup/reconcile/bot-errors-core-dispatcher-current-main-20260623` | 57 / 22 | UNMERGED |
| `backup/reconcile/bot-errors-dispatcher-port-20260623` | 60 / 21 | UNMERGED |
| `backup/reconcile/bot-errors-noise-core-20260623` | 61 / 15 | UNMERGED |
| `backup/reconcile/bot-errors-noise-core-public-20260623` | 60 / 3 | UNMERGED |
| `backup/reconcile/bot-errors-watchdog-port-20260623` | 57 / 27 | UNMERGED |
| `backup/rehearse/bot-errors-noise-20260623T012000Z-20260623` | 61 / 14 | UNMERGED |
| `backup/rehearse/bot-errors-perpick-20260623T013000Z-20260623` | 61 / 14 | UNMERGED |

† One backup branch name embeds an operator host label; redacted as `<host>` here for
public-repo hygiene. The re-verification snippet below enumerates branch names dynamically,
so the exact name does not need to be hard-coded.

**Recommendation:** owner decision tied to the noise-reduction initiative's status. These are
NOT pruning candidates on staleness alone — each holds unique commits not in `main`. If the
noise-reduction work has fully landed, the owner may retire a subset after confirming no unique
patch is lost (`git log --oneline origin/main..<branch>` per branch); otherwise leave them as
the safety net they were created to be.

## What this branch did NOT do (explicit non-actions)

- Did not merge, rebase, delete, or push any branch above.
- Did not touch the active healthcheck worktree or the idle-eviction worktree.
- Did not touch `src/` (the precise guard confirmed there is no insecure-tempfile in production —
  see the "production clean" delta in `../inventory.csv` and the session ledger).

## Re-verification (for the next agent)
Run from the repository root:
```sh
M=$(git rev-parse origin/main)
git rev-list --left-right --count $M...origin/fix/health-stale-serialization-f1
for b in $(git ls-remote --heads origin | grep -oE 'backup/[^ ]+$'); do
  echo "$b $(git rev-list --left-right --count $M...origin/$b)"
done
```
Counts will have drifted as `origin/main` advances — trust the live run, not this table.
