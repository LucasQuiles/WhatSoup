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
- `GET /health` `whatsapp.auth_bond` gains three additive transient-read
  fields. `transient_read_persistent` is a boolean: one transient credential
  read has persisted past the stale-risk bound. `transient_read_reason` is the
  single auth-bond issue that streak belongs to, or `null`.
  `transient_read_age_ms` is how long that streak has run, in MILLISECONDS, or
  `null` when none is open. They exist so an operator can reconcile an
  escalated `auth_failure_class` with an issue list whose entries mean "not
  right now": without them the two readings contradict each other and the
  response carries nothing to settle it.
- The streak is keyed by the reason. A different transient reason starts a new
  streak, so the reported reason and age always describe the same fault rather
  than one age accumulated across a succession of different ones.
- `whatsapp.connection.auth_failure_class` gains the value
  `auth_bond_read_persistent`. Consumers that enumerate the class MUST treat it
  as NON-TERMINAL and non-paging; it is reported with HTTP 200.
- Additive only: no existing `auth_bond` field changed name, type, or meaning,
  and no field was removed. Strict decoders that reject unknown members will
  see six new members, and one new value in an existing enumeration.

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
- The credential reader refuses an oversized `creds.json` at TWO separate
  points, and they are not the same rule. The first is a PRE-READ refusal: the
  descriptor's own `fstat` reports more than 1 MiB and no byte is taken. The
  second is a BOUNDED-READ refusal for a descriptor whose stat under-reported:
  the reader takes the cap and then probes for one more byte, so it deliberately
  reads 1 MiB plus one before refusing. Both report
  `creds_json_too_large:<bytes>`, and the reported count is what that path
  observed. Together they bound a synchronous read on the unauthenticated health
  path; `O_NONBLOCK` bounds the open but has no effect on reading a regular file.
- The read buffer is size-informed instead of cap-sized. It starts from the
  observed size (with a small floor) and doubles only when the descriptor
  actually yields more, so an ordinary ~150 byte credential no longer costs a
  1 MiB scratch allocation on every unauthenticated health request. The stat
  informs the allocation and is still never the bound.
- `EAGAIN` and `EWOULDBLOCK` from either credential open are reported as
  `auth_dir_read_transient:<errno>` or `creds_json_read_transient:<errno>`
  rather than as `creds_json_unreadable:<errno>`, so a "not right now" is
  distinguishable from a corrupt credential. The same errnos raised MID-READ,
  by the bounded loop or by the overflow probe, now take the same transient
  class; previously they fell through as `creds_json_unreadable:<errno>`, which
  is the input that pages as local corruption and satisfies the destructive
  restore's precondition. `EINTR` is retried rather than reported.
- The credential read is bounded in OPERATIONS as well as bytes. A descriptor
  that returns very short reads could otherwise take up to a million
  synchronous reads to reach the byte cap, blocking the event loop for all of
  them. Reaching the operation ceiling reports
  `creds_json_read_incomplete:<operations>`, which is a RETRYABLE class: it
  withholds the destructive restore exactly as the transient open classes do.
- A transient credential read degrades rather than pages:
  `whatsapp.connection.auth_failure_class` reports `auth_bond_at_risk` (HTTP
  200) instead of `local_corruption_restorable` / `local_corruption_unrestorable`.
  The auth-bond status itself is unchanged and still fail-closed. Past the
  120-second stale-risk bound the class becomes `auth_bond_read_persistent`,
  which is also degraded at HTTP 200. The escalation changes what is REPORTED,
  not how severely it is treated: the point is that an operator can tell a
  fault that has lasted two minutes from one seen once.
- The escalation is deliberately NOT a local-corruption class. Reporting an
  unreadable credential as `local_corruption_unrestorable` took `/health` to
  `unhealthy` (503) and put the instance in the watchdog's terminal set, which
  declines to restart and asks for a human relink — suppressing the restart
  that could clear a read fault, on evidence that never established corruption.
  `auth_bond_read_persistent` is absent from every terminal set, so the
  watchdog falls through to the ordinary restart policy.
- RETRACTION. An earlier draft of this note said the escalation opens a fleet
  outage record. It does not, and no code in this repository does. The
  mode-bucket contract, mapper and producers that would decide an outage have
  no runtime importer (they are listed as such in the orphan-reachability
  guard), and the recovery marker that would close such an outage is in the
  same unwired cluster. What is actually wired is this: the signal is exposed
  on the health surface as a degraded class and consumed by the fleet health
  poller's non-healthy path. Opening and closing an incident through an
  incident owner is NOT implemented and remains follow-up work.
- The persistence bound is PROCESS-LOCAL. The streak lives in guard memory and
  starts over on every process restart, so an instance restarting more often
  than the bound never escalates however long the underlying fault lasts. The
  streak is not persisted this round. `transient_read_age_ms` is the age of the
  current process's streak, so a small age on a long-running fault means the
  process is young, not that the fault is.
- A transient credential read no longer satisfies the precondition for the
  destructive quarantine-and-restore. That repair renames the live auth root
  away and replaces it from a backup, and its only precondition was a
  non-`present` status. It is now withheld until the next CONNECT ATTEMPT
  produces a definite read. A `/health` read does not lift it: `/health`
  re-reads the credential live, but nothing on that path calls the restore, so
  it cannot restore and never could. No tree walk is armed in the meantime
  because a walk cannot re-establish a credential and would only defer
  reader-driven walks.
- A withheld restore now ABORTS the connect attempt instead of continuing past
  it. The activation previously loaded the auth state anyway, and that reader
  initialises fresh credentials when the existing ones cannot be read or
  parsed, so a credential that was merely unreadable for one open could be
  replaced by an empty one and taken to QR, with nothing scheduling another
  attempt. The activation now returns before the auth state is loaded and
  schedules a reconnect on the existing backoff, so the retry is arranged
  rather than hoped for. The retries are bounded by the same stale-risk streak:
  once the transient outlives it, the attempt proceeds and the definite-read
  path decides.
- A failed auth-bond restore re-enters the convergence path with reason
  `auth-restore-failed` after the quarantine rollback, so a fresh walk is
  scheduled under the failure back-off instead of waiting for the next reader
  to arrive.
- A refusal raised on the auth ROOT no longer reports `creds.exists: true` for
  a credential it never examined, and no longer lets a root-side fault be
  described as a missing credential.
