# Maybe-Sent Ambiguity Episode Design

**Issue:** #2343

**Goal:** Give every active `maybe_sent` delivery its own durable ambiguity-entry clock so the live reconciliation and health paths honor the full late-echo grace period.

## Context

`created_at` describes when an outbound operation entered the queue, while
`submitted_at` describes when the provider acknowledged submission. Neither
describes a later pre-receipt ambiguity episode. An old queued operation can
therefore look stale the instant it becomes `maybe_sent` when the current
queries fall back to `created_at`.

## Options considered

1. Reuse `submitted_at` for pre-receipt failures. This would blur a recorded
   provider submission with an ambiguous send and break its existing meaning.
2. Keep deriving dwell from queue creation time. This retains the immediate
   replay/quarantine bug for old queued work.
3. Add a nullable, durable `ambiguity_at` timestamp. This records the actual
   entry to the current ambiguity episode while retaining a deterministic
   fallback for legacy rows. This is the selected approach.

## Selected design

Migration 52 adds nullable `outbound_ops.ambiguity_at` and backfills existing
`maybe_sent` rows from `submitted_at`, then `created_at`. The migration is
idempotent and runs inside the repository's existing migration transaction.

`markMaybeSent()` writes `ambiguity_at = datetime('now')` only when the row
enters `maybe_sent`; a repeated observation of an already-ambiguous row keeps
the original timestamp. A row that is reset to `pending` and later becomes
ambiguous receives a new timestamp.

The live reconciliation selector and health-age selector use the same effective
dwell expression:

1. A parseable `ambiguity_at` for the active episode.
2. For legacy rows, a parseable `submitted_at`, then `created_at`.
3. A bounded stale sentinel when the available chronology is malformed or
   absent, so corrupted data cannot manufacture freshness or a green health
   result.

Post-connect recovery remains an immediate history/corroboration pass rather
than a dwell-gated live sweep. The change is limited to the two decisions that
currently derive age: live reconciliation eligibility and health degradation.

## Validation contract

- An hour-old pending row that freshly enters `maybe_sent` remains there until
  the late-echo grace elapses and health reports the new episode time.
- A safe replay followed by re-entry receives a later episode time.
- A fresh pre-submission failure becomes stale after the existing grace window,
  preserving the null-submission visibility fix.
- An unsafe operation cannot take the live quarantine path before its current
  episode ages out; an echo inside the grace still settles normally.
- Migration backfill is deterministic, direct invocation is idempotent, and a
  surrounding transaction can roll it back.
- The health and alert surfaces continue to expose only bounded timestamps and
  aggregate evidence, never destination, message, transport-ID, path, command,
  or raw-error data.
