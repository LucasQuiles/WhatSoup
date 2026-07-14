# Task 1E-A database compatibility report

status: `DONE`

## Files changed

- `src/core/database-compatibility.ts`
- `src/core/database-compatibility-early.ts`
- `src/core/database.ts`
- `src/database-compatibility-bootstrap.ts`
- `tests/core/database-schema-ceiling.test.ts`
- `tests/core/database-compatibility-health.test.ts`
- `tests/database-compatibility-bootstrap.test.ts`
- `.superpowers/sdd/task-1e-database-report.md`

## Outcome

- The early inspector now returns explicit `ready`, `drained`, `permanent`, or `transient` outcomes. It uses the shared identity and schema implementations, opens existing databases read-only, and re-attests identity before and after schema inspection.
- The hold gate drains only `future_schema` and `engine_recovery_required`, wraps permanent compatibility failures for exit status 78, and throws transient errors unchanged. Direct check mode prints only `ready`, `future_schema`, or `engine_recovery_required`.
- Write-failure classification walks at most 32 distinct error/cause/AggregateError nodes and maps only the required SQLite numeric `errcode` and OS code markers. BUSY, FULL, IOERR, corruption, generic CANTOPEN, and unknown failures remain unclassified.
- Filesystem/writer-open, connection setup/transaction admission, and post-commit WAL failures use the narrow classifier. Transaction failures still attempt rollback first; a rollback failure retains the existing aggregate failure instead of being hidden. Classified failures latch the existing read-only/closed rejection fence.

## RED evidence

### Exact-head diagnostic before test edits

Command:

```bash
loadgate --strict -- bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/core/database-schema-ceiling.test.ts \
  tests/core/database-compatibility-health.test.ts \
  tests/database-compatibility-bootstrap.test.ts \
  --maxWorkers=1 --reporter=dot
```

- Exit: `1`
- Counts: `23 failed`, `32 passed` across 3 files.
- Finding: macOS exposed non-canonical `/var` temporary aliases to the intentional canonical-path rejection, and the legacy early inspector also returned `null` for the future-schema case. The tests now create artifacts below the canonical real path of the system temporary directory; production identity checks were not weakened.

### Cycle A — explicit early outcomes

Command:

```bash
loadgate --strict -- bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/core/database-schema-ceiling.test.ts \
  --maxWorkers=1 --reporter=dot -t 'early bootstrap outcome'
```

- Exit: `1`
- Counts: `8 failed`, `22 skipped`.
- Expected failures: hot-journal and future-schema returned the legacy flat status; current, missing, symlink, hardlink, and malformed artifacts returned `null`; the replacement observation seam was never reached.

### Cycle B — direct check and authoritative gate semantics

Command:

```bash
loadgate --strict -- bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/core/database-compatibility-health.test.ts \
  tests/database-compatibility-bootstrap.test.ts \
  --maxWorkers=1 --reporter=dot \
  -t 'direct inspection|direct --check|authoritative inspection|dependency-free inspection verdict'
```

- Exit: `1`
- Counts: `8 failed`, `1 passed`, `27 skipped`.
- Expected failures: the old consumers treated non-null outcome objects as drainable statuses, printed `ready` for drain/permanent/transient check results, and did not preserve permanent/transient failures. The ready authoritative test timed out because the legacy gate entered its drain path.

### Cycle C — real non-writable writer

Command:

```bash
loadgate --strict -- bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/core/database-compatibility-health.test.ts \
  --maxWorkers=1 --reporter=dot -t 'real non-writable DELETE-mode writer'
```

- Exit: `1`
- Counts: `1 failed`, `28 skipped`.
- Expected failure: a real current DELETE-mode database with file and directory write permission removed produced the generic `WhatSoupError: Database schema committed but post-commit WAL configuration failed` instead of terminal `database_not_writable`.

### Cycle C — classifier contract

Command:

```bash
loadgate --strict -- bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/core/database-schema-ceiling.test.ts \
  --maxWorkers=1 --reporter=dot -t 'database write compatibility classifier'
```

- Exit: `1`
- Counts: `18 failed`, `30 skipped`.
- Expected failure: `databaseWriteCompatibilityError` did not exist.

## GREEN and static evidence

- Pre-edit focused Test Integrity scan: exit `0`, no findings.
- Cycle A focused GREEN: exit `0`, `8 passed`, `22 skipped`.
- Cycle B focused GREEN: exit `0`, `9 passed`, `27 skipped`.
- Cycle C classifier GREEN: exit `0`, `18 passed`, `30 skipped`.
- Cycle C real permission GREEN: exit `0`, `1 passed`, `28 skipped`.
- Required integrated three-file suite after implementation: exit `0`, `85 passed` across 3 files.
- Post-edit focused Test Integrity scan: exit `0`, no findings.
- First `typecheck:all` correction run: exit `2`; the new exhaustive classifier needed an explicit terminal branch.
- Second `typecheck:all` correction run: exit `2`; generic `instanceof` narrowing exposed `reason` as `any`, corrected by binding the shared reason union explicitly.
- Final `loadgate --strict -- bash scripts/run-with-pinned-npm.sh run typecheck:all`: exit `0`.
- `bash scripts/run-with-pinned-npm.sh run guard:test-integrity`: exit `0`; status `pass`, 6 baseline findings, 0 new findings, 0 drifted findings.
- A combined scope diagnostic was discarded as inconclusive after its loop variable shadowed zsh's special `path` array and masked per-file `git` lookup failures. The direct replacement checks below did not reuse that probe.
- Fresh `git diff --check`: exit `0`.
- Fresh scope listing: exactly the seven allowed implementation/test files before this required report was added.
- Final required integrated three-file suite after the last production edit: exit `0`, `85 passed` across 3 files.

## Self-review

- Verified every reason maps to exactly one early outcome and both consumers are exhaustive over the four outcomes.
- Verified missing artifacts do not create a database or lock; existing artifacts share identity/schema inspection and are re-attested around schema reads.
- Verified the write classifier uses only exact numeric/OS markers, is bounded and cycle-safe, and has direct negative cases for every required unrelated failure class.
- Verified normalization occurs only at the requested writer boundaries. The transaction catch performs rollback before classification and retains both errors if rollback fails.
- Verified classified failures latch the existing compatibility rejection state and read-only/closed fence.
- Verified the working diff did not touch watchdog, health-poller, Test Integrity baseline, deploy, runtime manifest, or any other out-of-scope file.
- A bounded internal review lane and its child were interrupted after they did not return within the review window; no review result was treated as evidence. Direct source/diff review and the required root-owned external review remain the review evidence paths.

Remaining concerns: none.

No live database, service, deployment, or external-service action occurred. Tests used only temporary local database artifacts and in-process loopback test servers.
