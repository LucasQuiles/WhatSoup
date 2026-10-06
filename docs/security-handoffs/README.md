# Security Handoffs

This directory tracks security findings that belong to the WhatSoup application lifecycle. Keep host, fleet, and unrelated deployment posture out of these notes unless it is needed as generic deployment context.

Handoff index (each linked record owns its status and remaining acceptance work):

- [2026-05-09-env-secret-exposure.md](2026-05-09-env-secret-exposure.md#phase-status) - Process-environment secret exposure. The Phase Status table owns accepted source migrations, deployment verification and remaining wrapper/fallback removal. Merged source alone does not close the handoff. [The kickoff](2026-05-09-env-secret-exposure-kickoff.md) retains migration constraints and acceptance criteria.
- [2026-07-23-provider-data-policy.md](2026-07-23-provider-data-policy.md) - Provider-route classification and checkpoint admission are implemented in the Task 3 candidate; restricted-provider payload isolation and the cross-repository producer contract remain blocked.
- [2026-07-23-fleet-audit-status.md](2026-07-23-fleet-audit-status.md) - Exact source objects, evidence anchors, defect disposition, publication constraints, and residual cross-repository gates for Tasks 2, 3, 4, and 6.
- [2026-07-19-egress-allowlist-defense-in-depth.md](2026-07-19-egress-allowlist-defense-in-depth.md) - Egress threat model, proxy limitations and remaining isolation work.
- [Insecure-tempfile branch triage](insecure-tempfile/branch-triage-notes.md) - Supporting branch/evidence notes; verify their recorded scope before acting on a disposition.
