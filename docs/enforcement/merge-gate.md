# Merge-gate coverage: the canonical pre-merge local gate

## The rule

The canonical complete pre-merge local gate is:

```
npm run verify:push:branch
```

Resolution / fix / merge-preparation work **MUST** run it before pushing.
Running a symbol-referencing vitest subset (e.g. `npm test -- <a-few>.test.ts`)
is **NOT** sufficient and does not substitute for the full gate.

## Why a vitest subset is not sufficient (the invariant)

CI's `quality` job (`.github/workflows/quality.yml`) runs the **entire** test
suite via `npm run coverage:check` (`vitest run --coverage`, a strict superset
of a plain `vitest run`), plus every `guard:*` script. The complete gate is:

```
required = (functional suites that reference the changed files' modules)
           ∪ (ALL fitness / guard suites)
```

A local run that executes only the suites that reference a changed symbol
covers the FIRST half but not the second, and can even miss part of the first.
This has bitten us twice:

- **#1507** — a local resolution ran a symbol-referencing vitest subset and
  passed, but missed `tests/runtimes/agent/recovery-probe-validity.test.ts`,
  the suite most directly referencing the changed symbol. CI `quality` failed.
- **#1514** — a local run missed STRUCTURAL / fitness guard suites
  (`tests/scripts/dedup-reaccumulation-guard.test.ts`,
  `tests/scripts/fitness-file-size-warning-budget.test.ts`). CI `quality` failed.

`verify:push:branch` runs the guard scripts plus a FIXED enumerated subset of
vitest suites — it is intentionally faster than CI and does **not** itself run
the full `vitest run`. The invariant is therefore enforced by CI's full suite,
and locally the safe move is: **run `verify:push:branch`** (which, together with
its guard scripts, is the proven local proxy), and when in doubt run the full
`npm run coverage:check` before pushing.

## Fast triage aid: `scripts/required-suites.ts`

When the full chain is too slow for a tight iteration loop, use the triage aid:

```
# suites required for the changes on this branch (vs origin/main):
bash scripts/run-with-pinned-node.sh scripts/required-suites.ts

# or against an explicit base / explicit files:
bash scripts/run-with-pinned-node.sh scripts/required-suites.ts --base origin/main
bash scripts/run-with-pinned-node.sh scripts/required-suites.ts src/foo.ts src/bar.ts

# machine-readable:
bash scripts/run-with-pinned-node.sh scripts/required-suites.ts --json
```

It prints `required = functional ∪ fitness` for the given change:

- **functional** — every test suite whose text references a changed module's
  path or basename (closes the #1507 class), and any changed file that is itself
  a test suite.
- **fitness** — ALL fitness/guard suites (`tests/scripts/**` plus any
  `*guard*` / `*fitness*` suite), regardless of what changed (closes the #1514
  class).

The script is **WARN-tier / informational**: it always exits 0 and mutates
nothing. It is a triage aid to make the required set explicit, **not** a
substitute for `npm run verify:push:branch`.
