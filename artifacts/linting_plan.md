# Linting, Formatting, and Static Quality Gates

| Tool name | Command | Expected output | Blocking threshold | Artifact path | Owner |
|---|---|---|---|---|---|
| TypeScript | `npm run typecheck` | exit 0 | Any new type error blocks | `artifacts/typecheck.txt` | Worker |
| Vitest targeted | `npx vitest run tests/core/transport-refs.test.ts tests/transport/contract/*.test.ts --pool=forks` | exit 0 | Any failure blocks | `artifacts/transport_contract_tests.txt` | Worker |
| Scope diff | `git diff --name-only HEAD` | Allowed PR 0a paths only | Any production path blocks | `artifacts/changed_files.txt` | Worker |
| Baileys import inspection | `rg "@whiskeysockets/baileys" src tests` | No new PR 0a imports | New contract/testing import blocks | `artifacts/baileys_import_scan.txt` | Worker |
