# Spec: Instance-Loader Fixture Fix

**Status:** Draft (no implementation plan)
**Date:** 2026-04-25

Fix the one failing instance-loader test that reads a real, gitignored `instances/loops/instance.json` instead of a sanitized fixture.

---

## Symptom

Failing test:

```
FAIL  tests/instance-loader.test.ts > loadInstance — loops instance config > loads the loops instance.json from repo and validates correctly
ENOENT: no such file or directory, open '/Users/q/LAB/WhatSoup/instances/loops/instance.json'
```

---

## Root cause `[Inference]`

The test at line 522–544 of `tests/instance-loader.test.ts` reads the real file at `instances/loops/instance.json` via `fs.readFileSync`. That path is intentionally excluded from version control by the `.gitignore` rule at line 23 (`instances/*/instance.json`) because real instance configs contain phone numbers and API keys. Sanitized fixtures for this code path don't exist and aren't wired; the test was written against a developer-machine-local config and never adapted.

---

## Investigation tasks

- Read `tests/instance-loader.test.ts` — find every test that opens a path under `instances/`. Confirm line 525–527 is the only direct `fs.readFileSync` call against the real repo path.
- Read `tests/fixtures/` (if it exists) — does a sanitized fixture pattern already exist for instance configs? (The `tests/fixtures/` directory currently contains only `audio/`; no instance fixture pattern exists yet.)
- Read `.env.example` and any sanitized example config files — confirm whether a canonical safe-values convention is established elsewhere.
- Read the `.gitignore` rule at line 23 (`instances/*/instance.json`) — confirm it is intentional and document any existing exceptions (there are none; the only adjacent exception is `!.env.example`).

---

## Three candidate fixes ranked by minimal-impact

**(a) Move the test input to `tests/fixtures/instances/loops/instance.json` (sanitized) and update the test to point there.**
- What to change: create `tests/fixtures/instances/loops/instance.json` with placeholder phone numbers and keys; update the `fs.readFileSync` call to read from `path.join(import.meta.dirname, 'fixtures', 'instances', 'loops', 'instance.json')`.
- When this is the right fix: a `tests/fixtures/` pattern already exists for similar tests, or the team prefers a committed reference config that documents the expected schema.
- Smallest verifiable test: after the change, `npm test` passes the one failing case; `git status` shows no file under `instances/`.

**(b) Generate the fixture in a per-test temp directory using `mkdtempSync`.**
- What to change: replace the `fs.readFileSync` call with an inline object literal that mirrors the expected `loops` config shape; write it into `tmpDir` via the existing `writeInstance` helper.
- When this is the right fix: no committed sanitized config is wanted, and the test values are deterministic (they are — the assertions hardcode `name`, `type`, `accessMode`, and `agentOptions` fields).
- Smallest verifiable test: same — the one failing test passes; no new committed file is needed.

**(c) Add a sanitized tracked example under a non-secret path (e.g., `instances/.examples/loops/instance.json`) and adjust both the test and the `.gitignore` exception.**
- What to change: create `instances/.examples/loops/instance.json` with placeholder values; add a `!instances/.examples/` exception to `.gitignore`; update the test path.
- When this is the right fix: other tooling (docs, onboarding scripts) also needs a reference instance config under the `instances/` tree.
- Smallest verifiable test: `git check-ignore -v instances/.examples/loops/instance.json` returns no match; the failing test passes.

---

## Acceptance

When this spec's fix lands:

- The one instance-loader baseline failure passes.
- `docs/superpowers/specs/2026-04-25-baseline-test-failures.md` removes that row.
- No real `instances/*/instance.json` is ever committed.

---

## Out of scope

- no change to the transport layer (`src/transport/`, `src/core/`, `src/runtimes/`, `src/mcp/`)
- any console-test work (separate spec at `docs/superpowers/specs/2026-04-25-console-test-jsx-runtime-fix.md`)
- any non-test file under `instances/`
- any file PR 0a touches

---

## Implementation status

Documentation only; no implementation plan yet.
