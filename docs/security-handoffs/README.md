# Security Handoffs

This directory tracks security findings that belong to the WhatSoup application lifecycle. Keep host, fleet, and unrelated deployment posture out of these notes unless it is needed as generic deployment context.

Current open handoffs:

- [2026-05-09-env-secret-exposure.md](2026-05-09-env-secret-exposure.md) - WhatSoup process-environment secret exposure on a runtime host. Status: in-progress. Phase B provider migration is 3 of 7 done (OpenAI, Anthropic, ElevenLabs resolver-routed); 4 still open (Whisper, Pinecone, Knowledge MCP, health auth). Re-grounded 2026-07-01 against `origin/main` (#1431).
- [2026-07-23-provider-data-policy.md](2026-07-23-provider-data-policy.md) - Provider-route classification and checkpoint admission are implemented in the Task 3 candidate; restricted-provider payload isolation and the cross-repository producer contract remain blocked.
- [2026-07-23-fleet-audit-status.md](2026-07-23-fleet-audit-status.md) - Exact source objects, evidence anchors, defect disposition, publication constraints, and residual cross-repository gates for Tasks 2, 3, 4, and 6.
