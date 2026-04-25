# Sections Updated

PlanPrompt control contract, file structure, C20/deferred-scope wording, evidence artifacts, readiness/verification/hardening artifacts.

# Major Cross-Pass Upgrades

Evidence-root discipline, manifest ledger, assumption register, formal readiness, verification matrix, contradiction check, lint/static gates, regression protection, tooling plan, and final handoff requirements.

# Final Capability-Aware Synthesis

PR 0a is implementable as a behavior-neutral foundation if workers stay inside the allowed write scope and treat the current repo-wide npm test failure as an inconclusive baseline signal. Targeted transport-contract tests and typecheck are mandatory.

# Pinecone and Git Historical-Context Summary

Git context: plan committed at 29a0baf on main, ahead of origin/main by 2. Pinecone was not required for this local plan review; local repo/source scans were sufficient.

# Unresolved Risks

Repo-wide `npm test -- --pool=forks` currently fails in existing console tests due `react/jsx-dev-runtime` resolution. This must not be reported as a clean suite by PR 0a implementation.

# Reproduction and Closeout Steps

1. Review `artifacts/run_manifest.json` (gitignored — present only in workspaces that ran the original review; reproduce by re-running the review pipeline).
2. Run targeted PR 0a tests and store output under `artifacts/test_evidence/` (directory is gitignored — `mkdir -p` it first if absent).
3. Run `npm run typecheck`.
4. Run `bash scripts/check-baseline-test-drift.sh` against the frozen baseline at `docs/superpowers/specs/2026-04-25-baseline-test-failures.md`. Drift script returning non-zero blocks closure; do not classify drift as "inconclusive".
5. Confirm final diff stays inside PR 0a allowed paths.

Final verdict: Inconclusive
