# Security policy

## Supported versions

Security fixes target the current `main` branch and the latest published release.
Older releases may require an upgrade before a fix can be applied.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/LucasQuiles/WhatSoup/security/advisories/new).
Private reporting is enabled for this repository.

Do not include exploit details, credentials, private messages, fleet topology, or
personal data in a public issue. Include the following information in the private
report when it is available:

- affected version, commit, or deployment type;
- required privileges and configuration;
- the security boundary that failed;
- impact and a minimal safe reproduction;
- suggested remediation or compensating controls;
- logs or evidence with credentials and personal data removed.

If private reporting is unavailable, open a public issue that asks the maintainer
for a private contact channel. Do not include vulnerability details in that issue.

## Review and disclosure

The maintainer will assess the report, determine whether private coordination is
required, and reconcile it with existing advisories, issues, and pull requests.
Public disclosure can occur after a fix or an explicit disclosure decision.

The project tracks five separate states:

1. The source finding is established.
2. The remediation is accepted.
3. The implementation is verified.
4. The deployment is verified.
5. Operational protection is verified.

A source fix or closed issue does not establish deployment or operational
protection. Reports about a live instance can require separate owner-authorized
configuration and deployment checks.

## Safe research

Use accounts, instances, and data that you own or have permission to test. Stop
before accessing another person's data, disrupting a service, or changing an
external system. Preserve enough evidence to reproduce the failed control without
publishing credentials or weaponized instructions.
