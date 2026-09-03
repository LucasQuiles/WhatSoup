# 2026-09-03 Auth Bond Digest Refresh Provenance

## Public surface additions

- `GET /health` `whatsapp.auth_bond` gains three additive refresh-provenance
  fields. `digest_refresh_scheduled` is a boolean: a successor walk is queued
  but has not started. `digest_next_refresh_eligible_ms` is a non-negative
  number of MILLISECONDS until that queued successor may start, or `null` when
  none is queued. `digest_refresh_attempts` is a monotonic count of walks
  STARTED since process start, including ones that did not publish.
- The three fields describe the cached refresh scheduler only. On the live
  inspection path — `digest_source` and `digest_refresh_outcome` both `live` —
  `digest_refresh_scheduled` is `false` and the other two are `null`. That is
  the absence of a scheduler, not an idle one.
- `digest_refresh_attempts` counts cost and `digest_refresh_count` counts
  progress. Attempts climbing while the count stands still is the published
  signature of a walk that keeps failing. Neither counter is reset except by
  process restart, and neither controls scheduling.
- Additive only: no existing `auth_bond` field changed name, type, or meaning,
  and no field was removed. Strict decoders that reject unknown members will
  see three new members.

## Behavioral changes

- The 120-second stale risk bound is documented as a CLASSIFICATION bound. It
  guarantees that a digest older than the bound reports `unknown` rather than a
  stale `present`. It does not promise that a refresh lands within 120 seconds:
  the failure back-off doubles to a ceiling and a fifth attempt falls near 150
  seconds plus walk time.
- Every walk that fails or completes without publishing now queues its own
  retry under that back-off, including a cold or age-driven one that no
  invalidation started. Convergence no longer depends on a later reader.
- A reader no longer starts a walk while a successor is already armed, and a
  reader on a repeatedly failing tree is held by the same back-off as the
  scheduler. A persistently failing tree with a live 5-second poller settles to
  one walk per back-off ceiling instead of one walk per refresh floor.
- A successful walk cancels a successor it has made pointless, so
  `digest_refresh_scheduled` no longer reads `true` over a settled digest.
- The consecutive-failure streak is scoped to an invalidation episode. A new
  mutation no longer inherits an unrelated earlier streak and its maximum wait.
- The credential reader refuses a `creds.json` larger than 1 MiB by descriptor
  size, before reading it, and reports `creds_json_too_large:<bytes>`. This
  bounds a synchronous read on the unauthenticated health path; `O_NONBLOCK`
  bounds the open but has no effect on reading a regular file.
- `EAGAIN` and `EWOULDBLOCK` from either credential open are reported as
  `auth_dir_read_transient:<errno>` or `creds_json_read_transient:<errno>`
  rather than as `creds_json_unreadable:<errno>`, so a "not right now" is
  distinguishable from a corrupt credential.
- A transient credential read now degrades rather than pages:
  `whatsapp.connection.auth_failure_class` reports `auth_bond_at_risk` (HTTP
  200) instead of `local_corruption_restorable` /
  `local_corruption_unrestorable`. The auth-bond status itself is unchanged and
  still fail-closed.
- A transient credential read no longer satisfies the precondition for the
  destructive quarantine-and-restore. That repair renames the live auth root
  away and replaces it from a backup, and its only precondition was a
  non-`present` status. It is now withheld until a definite read, and a refresh
  retry is armed in the meantime.
- A refusal raised on the auth ROOT no longer reports `creds.exists: true` for
  a credential it never examined, and no longer lets a root-side fault be
  described as a missing credential.
