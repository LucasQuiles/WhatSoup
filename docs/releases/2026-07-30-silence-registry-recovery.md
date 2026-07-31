# 2026-07-30 Silence Registry Recovery

## Public surface additions

- `GET /api/fleet/silences` now returns typed availability metadata. A bounded
  last-known-good rule view is explicitly stale and never authorizes mutation;
  unavailable registry failures use the closed `fleet-error-v1` contract.
- `npm run fleet-silence-reset -- [--confirm-reset sha256:<revision>]` is a
  JSON-only local repair command. Its default inspection is read-only. An exact
  confirmation is required before it preserves an invalid registry in private
  quarantine and publishes a verified empty replacement.
- The compatibility registry now records the private silence generation marker,
  repair receipts, quarantine directory, and restart-safe outage episode state.

## Behavioral changes

- Missing first-run state is distinct from a registry that disappeared after a
  prior observed generation. Invalid, unreadable, symlinked, or other
  non-regular state never becomes an empty mute list or an unsilenced verdict.
- The Settings mute controls render unavailable, stale, uninitialized, and
  empty state separately, and disable add/remove until the server has a fresh
  current read.
- Registry-unavailable alert onset and recovery state survives normal restart
  and settles only after local durable queueing. This change does not make an
  exactly-once remote delivery guarantee.
- If the primary outage-episode journal is unreadable, a separate sticky
  failover ledger preserves it untouched and owns later onset/recovery state.
  The ledger remains authoritative even if the primary later appears readable,
  rather than trusting a potentially stale replacement.
- A restarted clock rollback reissues a stranded pending onset or recovery once
  immediately, then returns to the normal bounded retry interval.
