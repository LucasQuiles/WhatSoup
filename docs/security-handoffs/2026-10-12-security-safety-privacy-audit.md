# Security, safety, and privacy audit status

**Status:** Audit delivery candidate. Remediation, deployment, and operational
protection remain unverified unless a linked record states otherwise.

This record describes the audit method, coverage, and tracking contract for the
source baseline below. Detailed evidence for findings that require private
coordination is intentionally excluded from the repository.

## Baseline and scope

| Field | Value |
| --- | --- |
| Audit date | 2026-10-12 |
| Original source baseline | `f87d57bda8f06e963db5035e89380449d4d66c6b` |
| Publication comparison baseline | `9bb8a6cf8e8926f3983dbc89f416b48ffb2cd7b3` |
| Repository | `LucasQuiles/WhatSoup` |
| Authorization | Source audit, documentation, and tracking preparation |

The publication comparison changed only the CI control tree reader and its tests;
none of the recorded audit claims required revision.

The audit covered application source, tests, workflows, deployment scripts,
dependency metadata, agent and MCP boundaries, persisted data, incident handling,
and repository-visible release controls. It also reconciled current public issues,
pull requests, security settings, Dependabot alerts, and relevant predecessor work.

The audit did not inspect live fleet configuration, running binaries, provider
retention settings, external vector-store contents, or deployed protection. Those
gaps remain explicit. No merge, deployment, credential rotation, security-setting
change, or recurring task activation is part of this audit delivery.

## Method

The review traced each candidate through its entry point, enforcing control,
failure behavior, test coverage, and operational dependency. A candidate was not
accepted solely because a setting or check existed. The review asked whether each
execution route applied the control and whether unavailable evidence failed closed.

Current issues, draft and open pull requests, predecessor closures, and unmerged
work were checked before preparing new tracking. Findings were deduplicated by the
failed control, affected boundary, and required remediation.

The disclosure decision uses three classes:

- **Public:** The full remediation record can be published now.
- **Sanitized public:** Public tracking can describe the outcome and acceptance
  criteria while exploit-enabling evidence remains private.
- **Private coordination:** The finding stays in a repository security advisory
  until mitigation or an explicit disclosure decision.

## Result

The review supported remediation work across the following control groups:

| Control group | Source result | Required next proof |
| --- | --- | --- |
| CI and release supply chain | Failed controls were established in secret use, dependency reproducibility, container identity, and generated-asset provenance. | Verify the accepted implementation on the exact merge candidate, then verify released artifacts. |
| Fleet credentials and authentication | Source behavior does not consistently meet the current transport and private-file contracts. | Verify migration, revocation, local file invariants, and each HTTP and WebSocket route. |
| Agent and MCP authority | Several direct, delegated, scheduled, and connector paths need stronger authority binding or focused exposure tests. | Test every route at the mutation boundary with expired, revoked, ambiguous, and unavailable authority. |
| Provider and outbound data boundaries | One optional provider path bypasses the route-policy admission model. Address classification also has a reserved-range coverage gap. | Prove policy evaluation and destination checks immediately before each dispatch and connection. |
| Data lifecycle | Handoff artifacts, direct remote memory, and incident payloads lack complete retention or erasure proof. | Verify active stores, retries, restores, backups, and provider deletion limitations separately. |
| Persistent context | One privileged memory class lacks the inert instruction boundary used by ordinary recalled content. | Prove that stored content cannot alter authority, tool choice, destination, or future-session policy. |
| Incident and recovery control | The operational BOT ERRORS path is not yet the authenticated incident authority. Recovery and resource bounds have additional gaps. | Prove origin, replay handling, bounded attempts, independent recovery verification, and a safe unavailable state. |
| Configuration truth | One parsed authorization setting is not enforced. | Reject unsupported settings or enforce them at every output boundary. |
| Dependency advisories | The installed graph contains current public advisories already visible to Dependabot. | Correlate the exact call path, upgrade to a fixed graph, and verify the exercised behavior. |

The detailed finding register owns the final record count, disclosure class,
predecessor links, and issue or advisory body. This document does not make those
private details public by implication.

One original candidate changed after source revalidation. The URL-watch path now
uses the shared guarded fetcher with connect-time and redirect-hop checks. The
remaining network finding concerns address-classification coverage in that shared
control. The audit does not claim that the original per-hop defect still exists.

## Verification evidence and limits

Focused tests passed for handoff, memory-write, outbound identity, client-output
policy, secure token-file handling, and the shared guarded fetcher. The legacy
fleet-token suite passed after loopback binding was allowed. Its first sandboxed
run was inconclusive because the sandbox denied the listener.

An initial dependency installation failed because registry and native-build network
access was unavailable. The approved retry completed with the pinned Node runtime.
`npm audit` then reported five moderate advisories in one transitive package. This
is an advisory match and installed-version fact; it is not proof of remote
exploitability.

The current repository settings show private vulnerability reporting, secret
scanning, push protection, and Dependabot security updates enabled. Repository
settings do not establish that a deployed instance is protected.

The CISA Known Exploited Vulnerabilities feed could not be retrieved during the
research pass. A complete current KEV reconciliation is therefore inconclusive.

## Acceptance and closure

Each remediation record must identify the affected environment, enforcing control,
positive test, negative test, bypass test, evidence location, remaining limitation,
owner, and deployment-verification requirement. Skipped, masked, failed, timed-out,
or unexecuted checks remain visible and cannot support a clean result.

Use these lifecycle states without collapsing them:

`source finding established -> remediation accepted -> implementation verified -> deployment verified -> operational protection verified`

Closing a tracking record requires evidence for the state it claims. Later states
can remain pending when the work is source-only.

## Reference baselines

The audit uses NIST CSF 2.0 for outcome coverage, NIST SSDF 1.1 for development
practice, OWASP ASVS 5.0 for applicable application verification, RFC 9700 and the
implemented MCP authorization version for token handling, SLSA 1.2 for release
provenance, NIST SP 800-61 Rev. 3 for incident response, and the NIST Privacy
Framework for privacy-risk organization. Versioned references support the local
acceptance criteria; they do not create a compliance or certification claim.

The ongoing source and applicability process is defined in
[security-intelligence-process.md](security-intelligence-process.md).
