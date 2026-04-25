# Regression Protection and Change Safety

| Protected behavior | Protection mechanism | Regression signal | Evidence source | Rollback or mitigation trigger |
|---|---|---|---|---|
| Current WhatsApp runtime behavior | No runtime/MCP/DB/logger/config/fleet file changes | Diff includes production path | `artifacts/changed_files.txt` | Stop and split into later PR |
| Current schema | No `src/core/database.ts` changes | DB file touched | `artifacts/changed_files.txt` | Move to PR 0b |
| Current logging | No Pino/root logger changes | logger file touched or C20 claimed | `artifacts/contradiction_check.md` | Move to PR 0d |
| Existing test baseline | Typecheck plus full-suite baseline recorded | New failures in targeted lane | `artifacts/typecheck.txt`, `artifacts/npm_test.txt` | Fix before merge |
| Contract behavior | C1-C19 conformance | Failed conformance row | `artifacts/test_evidence/conformance.txt` | Block PR 0a |
