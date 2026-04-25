# TDD Scope

PR 0a uses test-first steps for behavior-bearing utilities: refs, queue, fanout, errors, conformance, capability-negative, and subscriber lifecycle. Type-only modules may be validated through typecheck and type-level smoke tests.

# Red Phase Verification

Each task with a new test file requires an initial failing run caused by missing module or missing behavior. The failing command output is stored under `artifacts/test_evidence/<task>-red.txt` during implementation.

# Deterministic Validation

Use Vitest `--pool=forks`. Avoid sleep-based assertions except where deterministic fake timers or explicit promises control ordering.

# Test Provenance

Every green assertion must map to spec sections listed in the plan header. C20 redaction provenance is intentionally absent in PR 0a and deferred to PR 0d.

# Independent Validation

Independent validation is diff-scope and contradiction review, not live provider testing. Real Baileys/Telegram behavior is out of scope.

# Replay Artifacts

Store command output under `artifacts/test_evidence/` and record commands in `artifacts/run_manifest.json`.
