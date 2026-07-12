# Turn Lifecycle Fitness Extraction Design

**Date:** 2026-07-11
**Status:** Approved for implementation

## Context

The canonical turn-lifecycle consolidation passes its focused behavior suites, but the full release
gate identified five file-size ratchet violations:

- `src/core/database.ts` grew from 1,501 to 2,372 lines.
- `tests/core/migration-safety.test.ts` grew from 1,607 to 2,453 lines.
- `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts` is a new 2,176-line file.
- `src/runtimes/agent/runtime.ts` grew from 9,640 to 9,920 lines despite extracting substantial
  lifecycle logic into focused modules.
- `tests/runtimes/agent/runtime.test.ts` grew from 12,653 to 13,007 lines, exceeding its recorded
  baseline ceiling (identified during implementation preflight; ratchet disposition approved by the
  owner on 2026-07-11).

The release fix must preserve migrations 37–40, their safety coverage, and all turn-terminal
behavior. It must not silence the fitness gate by broadly grandfathering newly oversized files.

## Decision

Use behavior-preserving extractions for the three newly oversized files. Consciously ratchet the
two already-grandfathered files — `src/runtimes/agent/runtime.ts` and
`tests/runtimes/agent/runtime.test.ts` — after measuring their final line counts. No other file
receives a ceiling adjustment.

## Production Structure

Create `src/core/database-migrations-37-40.ts` as the implementation home for migrations 37–40.
It will export one function per migration and depend only on `node:sqlite` contracts.

`src/core/database.ts` will retain small `runMigration37` through `runMigration40` wrappers. The
wrappers preserve the existing ordered migration table and the static migration-numbering guard,
while delegating the SQL and validation bodies to the new module. Migration SQL, transaction
boundaries, error propagation, trigger installation, and replay/idempotency behavior remain
unchanged.

No runtime turn behavior moves merely to reduce `runtime.ts`. That file has already shed lifecycle
responsibilities into the coordinator, result handler, supervisor, and finalization modules; a new
late-stage extraction would be more coupled and riskier than a reviewed ceiling adjustment.

## Test Structure

Move the contiguous migrations 37–40 suites out of `tests/core/migration-safety.test.ts` into
`tests/core/migration-turn-lifecycle.test.ts`. Move only the helpers required by those suites; do
not duplicate the large legacy migration fixtures.

Create `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts` for the integration
suite's shared runtime state type, context builder, durability/reply-guarantee mocks, queue/session
stubs, messenger, and runtime-state constructor. The integration test will retain its behavioral
describes and assertions while importing that harness.

These are physical reorganizations. Test names, assertions, fixture values, and production call
paths remain unchanged except where an import/export boundary is required.

## Fitness Ratchet

After the extractions and bug fixes are complete:

1. Measure all affected files with `wc -l`.
2. Confirm all six extraction outputs are below the 2,000-line warning threshold:
   `src/core/database.ts`, `src/core/database-migrations-37-40.ts`,
   `tests/core/migration-safety.test.ts`, `tests/core/migration-turn-lifecycle.test.ts`,
   `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts`, and
   `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts`.
3. Update the `lines` and `maxLines` values for BOTH `src/runtimes/agent/runtime.ts` and
   `tests/runtimes/agent/runtime.test.ts` in `.claude/fitness/baseline.json` to their exact
   final counts.
4. Update the two matching rows in `docs/architecture/fitness-taxonomy.md` to the same counts.

No new baseline entries will be added for `database.ts`, the migration tests, the terminal
integration test, or any extracted module.

## Failure Handling

- Migration wrappers must propagate implementation errors unchanged so `Database.open()` retains
  its existing rollback and migration-failure behavior.
- The extraction must not introduce dynamic imports or optional fallback paths.
- If any moved test loses coverage because a shared helper cannot be isolated without duplication,
  stop and keep that test with its original harness rather than weakening assertions.
- Any source-runtime manifest change must be regenerated and checked before commit.

## Verification

Run, in order:

1. Focused migration 37–40 and migration-numbering tests.
2. Focused runtime terminal coordinator, result-handler, supervisor, strip-types, deduplication,
   and per-chat empty-output tests.
3. `npm run typecheck:all`.
4. `npm test -- tests/scripts/fitness-file-size-warning-budget.test.ts --pool=forks`.
5. `npm run work-index:regen` followed by a clean `npm run guard:work-index` (this design document
   is indexed work).
6. Source-runtime, documentation, publication, Test Integrity, and repository guards, then the
   complete `npm run verify:push:branch` battery.
7. The complete unmasked `npm run verify:release` gate.

Every gate above is mandatory; a skipped, masked, or interrupted run does not count. Only a clean,
unmasked release result authorizes push, pull-request creation, or merge.

## Non-goals

- Redesigning the migration framework.
- Changing schema version 40 or adding migration 41.
- Reworking runtime lifecycle semantics during a file-size repair.
- Adding new fitness exceptions for avoidable file growth.
