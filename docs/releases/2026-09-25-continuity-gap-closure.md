# 2026-09-25 Continuity Gap Closure

## Public surface additions

- New operator command `npm run close-continuity-gap` (`cli:npm.close-continuity-gap`,
  beta). It closes one recorded continuity gap as `addressed` or `declined`,
  bound to protected evidence files. Preview is the default: it reads only a
  static `--snapshot` copy opened `immutable=1` and writes nothing. `--apply`
  rechecks every file digest and database link inside `BEGIN IMMEDIATE` on the
  live `--db` and appends at most one row. It exits `0` for ready, applied or
  already closed, `2` for Blocked, `3` for `CLOSURE_PROOF_CONFLICT`, and `1` for
  usage or I/O errors. It never sends, replays, admits, or edits the recorded
  gap. See `docs/runbook.md`, "Close a continuity gap (addressed or declined)".
- New evidence contracts: `continuity-closure-evidence.v1` (per-closure manifest),
  `continuity-closure-decision.v1` (decline record), and
  `continuity-closure-authority.v1` (per-instance owner policy that gates
  `declined`). The repository ships no policy file.
- `GET /health` `continuity` (and `recovery_debt.continuity`) gains the fields
  `closure_ledger`, `total`, `ambiguous_total`, `closed`, `addressed`, and
  `declined`. The counts always reconcile: `total = open + closed`,
  `open = unresolved + ambiguous`, and `closed = addressed + declined`.
  `ambiguous` now counts only open, originally ambiguous gaps; `ambiguous_total`
  keeps the ones that were later closed.

## Behavioral changes

- Schema migration 65 adds the append-only `continuity_gap_closures` table.
  After it is recorded, a schema-64 binary refuses the database as
  `future_schema`. A binary-only rollback is therefore unavailable; keep the
  65-aware release for containment or forward repair.
- The bump changes `schema_version` inside D5 capability attestation bindings.
  Previously recorded attestation digests stop admitting on this binary, and the
  AS-01 rehearsal must be re-run at rollout.
- An unreadable continuity ledger now reports every continuity count as `null`
  instead of `0`. Strict decoders that expected numbers in the unreadable case
  must accept `null`; `readable: false` and the `continuity_gap_unreadable` cause
  are unchanged.
- A valid closure removes its gap from the open count. Only `open > 0` raises
  `continuity_gap_open`. `turn_recovery_degraded` is derived separately and is
  never cleared by a closure.
- `close-recovery-catchup` documentation is corrected. It requires a contiguous
  migration ledger of at least 43 entries (any later schema, including 65, is
  accepted), not an "exact schema 43" database. It still closes only admitted
  inbound sequences.
