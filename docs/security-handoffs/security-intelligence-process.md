# Security intelligence process

**Status:** Design and tracking contract only. No collector or recurring task is
activated by this document.

This process correlates current security intelligence with WhatSoup's installed
and reachable assets. It extends the existing incident, observation, and BOT ERRORS
surfaces. It must not create a second scheduler, incident database, or autonomous
remediation authority.

## Source register

Maintain one register with these fields:

`source -> authority -> scope -> collection method -> owner -> expected freshness -> last successful collection -> failure state`

The initial source set is:

| Source | Purpose | Expected review |
| --- | --- | --- |
| CISA Known Exploited Vulnerabilities catalog | Confirmed exploitation evidence | Daily and after exposure changes |
| Vendor security advisories | Affected versions, fixed versions, and prerequisites | Daily for installed products |
| OSV and GitHub Advisory Database | Open-source vulnerabilities and malicious packages | Daily against exact package identities |
| GitHub Dependabot alerts | Repository-specific dependency matches | Daily and on lockfile changes |
| FIRST EPSS | Dated exploitation-likelihood context | Daily for applicable CVEs |
| First-party threat research | Campaigns, techniques, and defensive hypotheses | Weekly |
| NIST, OWASP, IETF, MCP, GitHub, SLSA, MITRE | Standards, protocol, and implementation changes | Weekly |

Collection failure and “no applicable item” are different results. Preserve the
last successful collection time and the failure reason.

## Applicability record

For each relevant item, record:

`identifier -> published date -> updated date -> observation period -> product -> affected versions -> installed match -> reachable path -> execution identity -> privileges -> sensitive assets -> confidence -> disposition -> tracking link`

Use one of these dispositions:

- verified remediation;
- investigation needed;
- already covered;
- bounded deferral;
- not applicable with evidence.

Reopen the assessment when an advisory changes, an asset becomes reachable, a
permission changes, a compensating control fails, or an earlier assumption becomes
true. Search current issues and pull requests before creating new tracking.

## Processing rules

Treat every feed and advisory as untrusted data. The collector can retrieve,
normalize, correlate, and report evidence. It must not execute advisory commands,
apply suggested patches, access credentials, change a repository, deploy, or change
security policy.

Use bounded parsing, the shared guarded network client, exact package and version
matching, correction and withdrawal processing, and explicit source provenance.
An intelligence match can change priority. It cannot authorize remediation.

Match findings to effective state:

`asset -> owner -> installed version or digest -> effective configuration source -> execution identity -> privileges -> inbound access -> outbound destinations -> evidence -> verification gap`

Declared configuration is evidence about intent. It is not evidence about the
binary or policy that a live service uses.

## Operational integration

Use the existing daily health timer for collection health and the existing incident
store for authenticated, replay-aware signals. Use BOT ERRORS as a human notification
channel after the incident authority accepts the signal. A successful message send
does not establish incident acceptance, diagnosis, repair, or recovery.

The intended cadence is daily advisory correlation, weekly campaign and standards
review, and immediate re-evaluation after dependency, deployment, permission, or
exposure changes. Activation requires a separate reviewed implementation and an
owner-approved schedule change.

Each result must preserve check accounting. Report executed, passed, failed,
skipped, masked, and unavailable checks separately. The reporting path must emit a
failure when a source becomes stale or unreachable.

## Standards register

Pin the version and status used by an audit. Track draft documents separately from
final standards.

| Baseline | Version used on 2026-10-12 | Use |
| --- | --- | --- |
| NIST Cybersecurity Framework | 2.0 | Organize governance, protection, detection, response, and recovery gaps |
| NIST Secure Software Development Framework | 1.1 final | Development baseline; track 1.2 separately while draft |
| OWASP Application Security Verification Standard | 5.0.0 | Applicable application verification requirements |
| OWASP AI security guidance | LLM Top 10 2026 and current agent-control publications | Coverage prompts; local tests remain authoritative |
| OAuth Security Best Current Practice | RFC 9700 | Token, redirect, audience, and resource handling |
| Model Context Protocol authorization | Implemented specification version | HTTP authorization; keep local process transports separate |
| SLSA | 1.2 | Source, build, provenance, and verification controls |
| NIST incident response | SP 800-61 Rev. 3 | Evidence, escalation, containment, recovery, and lessons learned |
| NIST digital identity | SP 800-63-4 | Applicable human authentication and recovery requirements |
| NIST Privacy Framework | 1.0 | Privacy-risk organization; track 1.1 separately while draft |
| NIST media sanitization | SP 800-88 Rev. 2 | Applicable media evidence, without inferring remote provider deletion |
| FIRST CVSS and EPSS | CVSS 4.0 and current EPSS data | Separate technical severity from exploitation likelihood |
| MITRE ATT&CK and ATLAS | Pinned data release | Technique and detection coverage |

GitHub workflow dependency lockfiles remain a public-preview option. Evaluate their
availability and reusable-workflow coverage before adoption. Keep supported immutable
references when the preview does not cover the required workflow boundary.
