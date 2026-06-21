# Spec: Console-Test JSX-Runtime Fix

**Status:** completed - root Vitest now aliases React JSX runtimes; retained as a historical failure record.
**Superseded by:** `vitest.config.ts` React runtime aliases and current console test suites.
**Date:** 2026-04-25

This spec documents the JSX-runtime resolution failure that blocks all console test files and outlines investigation tasks and candidate fixes.

---

## 1. Symptom

Verbatim error from `artifacts/npm_test.txt`:

```
Error: Cannot find module 'react/jsx-dev-runtime' imported from '/Users/q/LAB/WhatSoup/console/src/pages/Ops.tsx'.

- If you rely on tsconfig.json's "paths" to resolve modules, please install "vite-tsconfig-paths" plugin to handle module resolution.
- Make sure you don't have relative aliases in your Vitest config. Use absolute paths instead.
```

Scale:
- **18 named test failures** across **13 console test files** — individual test cases fail with this error.
- **7 additional file-level collection failures** — each of those files fails before any individual test runs; no test results are reported for them at all.

All failures originate in test files under `tests/console/` that import `.tsx` source from `console/src/`.

---

## 2. Likely Root Cause `[Inference]`

`[Inference]` Vitest cannot resolve React's automatic JSX runtime (`react/jsx-dev-runtime`) when transpiling `.tsx` files sourced from `console/src/`. The error message from Vitest explicitly names `tsconfig.json` `paths` as a likely culprit and recommends the `vite-tsconfig-paths` plugin, which suggests the console module graph relies on `tsconfig` path aliases that Vitest does not honor in its default configuration. This is a hypothesis — it has not been confirmed by reading the configs.

---

## 3. Investigation Tasks (read-only — no fix in this spec)

- Inspect root `vitest.config.ts` and `console/vitest.config.ts` (if it exists) for `resolve`, `plugins`, and `test.environment` settings.
- Inspect `console/package.json` and root `package.json` for `react` and `react-dom` declarations (version, placement in `dependencies` vs `devDependencies`).
- Inspect root `tsconfig.json` and `console/tsconfig.json` for `paths`, `jsx`, and `compilerOptions.types`.
- Check whether `vite-tsconfig-paths` is currently installed:
  ```
  grep -r "vite-tsconfig-paths" package.json package-lock.json
  ```
- Run `npm ls react react-dom` from repo root to confirm hoisting state and which sub-package owns the declarations.

---

## 4. Candidate Fixes (ranked by minimal-impact)

> **Investigate before picking.** The ranking below is an inference from the Vitest error message and typical Node/React module-resolution failure modes — not an instruction. The §3 investigation tasks must run first. Whichever candidate the actual evidence supports is the right one regardless of position in this list.

**(a) Install `vite-tsconfig-paths` and add it to `vitest.config.ts` plugins**

- **What to change:** `npm install --save-dev vite-tsconfig-paths`; add `tsconfigPaths()` to the `plugins` array in `vitest.config.ts`.
- **When this is the right fix:** `tsconfig.json` `paths` entries are the mechanism wiring `react/jsx-dev-runtime` into the module graph and Vitest is ignoring them.
- **Smallest verifiable test:** Re-run the 13 previously-failing console test files; all 18 named failures and 7 collection failures should resolve.

**(b) Hoist `react` + `react-dom` to root `devDependencies`**

- **What to change:** Move or copy `react` and `react-dom` declarations from `console/package.json` into the repo-root `package.json` `devDependencies`, then re-run `npm install`.
- **When this is the right fix:** The packages are only declared under `console/`, causing node_modules resolution to fail when Vitest searches upward from the repo root.
- **Smallest verifiable test:** `npm ls react react-dom` from repo root shows a hoisted entry; re-running the failing tests confirms resolution.

**(c) Configure Vitest's `resolve.alias` for `react/jsx-dev-runtime`**

- **What to change:** Add an explicit `resolve.alias` entry in `vitest.config.ts` mapping `react/jsx-dev-runtime` (and `react/jsx-runtime`) to their absolute node_modules paths.
- **When this is the right fix:** Candidates (a) and (b) do not apply or do not fully resolve the issue; a hard alias is needed as a last resort.
- **Smallest verifiable test:** Re-run the failing console tests; 18 named failures and 7 collection failures pass.

---

## 5. Acceptance

When this spec's fix lands:

- All 18 named test failures pass.
- All 7 file-level collection failures pass.
- `docs/superpowers/specs/2026-04-25-baseline-test-failures.md` removes those rows (Group A, both the named-test rows and the 7 collection-failure file paths if listed separately).
- `scripts/check-baseline-test-drift.sh` is rerun and exits 0 against the updated baseline.

---

## 6. Out of Scope

This spec does NOT touch:

- `src/transport/`
- `src/core/`
- `src/runtimes/`
- `src/mcp/`
- any file PR 0a touches
- the instance-loader fixture failure (separate spec at `docs/superpowers/specs/2026-04-25-instance-loader-fixture-fix.md`)

---

## 7. Implementation Status

This spec is retained as a historical failure record. The current root `vitest.config.ts` aliases `react/jsx-runtime` and `react/jsx-dev-runtime`, so this no longer represents active work.
