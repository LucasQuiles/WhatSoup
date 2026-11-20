# 2026-11-20 Auth Bond Capture Yields

## Behavioral changes

- The auth-bond capture no longer holds the event loop for its whole run.
  - It runs in bounded slices and hands the loop back between them. One budget
    covers the whole run: a slice holds at most 64 units, where a walk entry
    costs 1 and a copy or delete entry costs 4. A phase boundary, the next
    staging orphan or the next pruned entry does not restart the count.
  - Credential saves, key writes and health requests are served during a
    capture.
  - Total capture time is not bounded and can grow somewhat under load. It is
    logged as `elapsedMs`.
  - `maxSliceMs` counts only the capture's own synchronous work. Time inside a
    yield, the retry sleep or an abort's wake is not counted.
- An entry that vanishes between the walk's listing and its read, such as a
  consumed pre-key or a creds saver's temporary file, no longer fails the
  capture.
  - In the pre-copy walk it is an incomplete read: the attempt defers with
    `auth bond auth tree read was incomplete`, sends no alert and sets no
    latch.
  - In the copy, the entry is skipped. Validation then finds the tree changed
    with the same identity, and the attempt defers.
  - The bound: after six consecutive runs end deferred on an incomplete read,
    the seventh such run fails with `... incomplete in 7 consecutive runs` and
    pages, as an incomplete read paged before. Any run that ends otherwise
    resets the count.
- A failed `latest.json` write renames the new history entry back into staging
  before removing it, and removes it in slices.
- A capture run always settles, even when building its failure result fails
  too (for example, a `latest.json` whose `backupPath` is not a string).
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
- Deferred and floor-limited capture requests re-arm. A capture that ends
  failed is not re-armed, as before; it pages.
  - Requests made during a capture fold into one trailing capture.
  - A capture that ends deferred re-arms the 60-second settled snapshot. Its
    `auth_snapshot_scheduled` record is built from the capture's result, with
    no second walk.
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
  - The block holds from the close handler's logout decision until the next
    open, even when the logout alert could not be enqueued.
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
- The existing error texts, the other deferral rules and the fresh-write grace
  are unchanged. The incomplete-read deferral and its bound add two error
  texts. The defaults of 3 attempts and a 75 ms retry delay are unchanged.
- A prune error after a successful publish still reports a failed capture, even
  though `latest.json` already names the new backup. A follow-up will address
  it.

## Known limits

- No alert covers backup age. A `consecutiveDeferrals` value that keeps
  climbing on an active instance means `latest.json` is getting old.
- Busy instances may defer more often, because writes can now land between a
  file's two reads, or between its listing and its read.
- Six consecutive incomplete reads defer before the seventh pages. The deferred
  re-arm and the 5-minute floor space those runs, so a tree that never reads
  completely pages about 30 minutes after its first incomplete read, where it
  used to page at once.
- With a data root set, some synchronous walks still run on the event loop and
  can add stalls on a large tree. The open handler pays three: the
  `connection_open` record's fields, its bond event and the persist. Just after
  a capture settles, the bond event of its captured, skipped or failed record
  and the settle persist pay one each. The deferred re-arm's record pays none.
