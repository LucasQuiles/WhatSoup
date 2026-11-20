# 2026-11-20 Auth Bond Capture Yields

## Behavioral changes

- The auth-bond capture no longer holds the event loop for its whole run.
  - It runs in bounded slices and hands the loop back between them: 64 entries
    per walk slice, and 16 per copy or delete slice.
  - Credential saves, key writes and health requests are served during a
    capture.
  - Total capture time is not bounded and can grow somewhat under load. It is
    logged as `elapsedMs`.
- The retry delay between deferred attempts is an awaited timer. It no longer
  parks the main thread with `Atomics.wait`.
- Every capture logs `auth bond capture started` and `auth bond capture
  finished`, both with the same `run` number.
  - The finished line carries `outcome`, `elapsedMs`, `attempts`, `slices`,
    `maxSliceMs`, `phaseMs`, `fileCount`, `totalBytes`, `error` and
    `consecutiveDeferrals`.
  - The existing `auth bond snapshot captured`, `auth bond snapshot deferred`
    and `auth bond snapshot failed` lines are unchanged.
- The publish rule is unchanged: a backup is published only when the copy
  matches the capture's own pre-copy walk. The abort flag and the logout block
  reason are now also re-checked in the publish turn, immediately before the
  rename.
- No capture request is dropped.
  - Requests made during a capture fold into one trailing capture.
  - A capture that ends deferred re-arms the 60-second settled snapshot.
  - A settled snapshot refused by the 5-minute floor is re-armed for the rest of
    the interval instead of being dropped. Its `auth_snapshot_skipped` record
    (`settled-snapshot-min-interval`) is unchanged.
- A capture refused because a logout or bond-lost state is active is no longer
  treated as a failure.
  - It records `auth_snapshot_skipped` with note `capture-blocked:<reason>`.
  - It no longer pages `whatsapp_auth_bond_local_failure` and no longer counts
    as a capture failure.
  - A logout does not establish a local credential fault, and the logout path
    pages its own alert.
- Restore and shutdown now abort an in-flight capture.
  - A restore aborts it just before the restore's first write.
  - Shutdown aborts it and refuses later requests.
  - An aborted capture publishes nothing. It is recorded as
    `auth_snapshot_skipped` with note `capture-aborted:<error>`.
- On connection open, the credential lifecycle now records `connection_open`
  before `auth_snapshot_captured`, because the capture settles after the open
  handler returns. Runtime state is persisted again, with event
  `auth_snapshot_settled`, when a capture settles while the connection is still
  open.

## Unchanged

- No `/health` field, configuration field or environment variable changed.
- Error texts, deferral rules and the fresh-write grace are unchanged. The
  defaults of 3 attempts and a 75 ms retry delay are unchanged.
- A prune error after a successful publish still reports a failed capture, even
  though `latest.json` already names the new backup. A follow-up will address
  it.

## Known limits

- No alert covers backup age. A `consecutiveDeferrals` value that keeps
  climbing on an active instance means `latest.json` is getting old.
- Busy instances may defer more often, because writes can now land between a
  file's two reads.
