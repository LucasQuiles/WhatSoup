# Deployment qualification

Deployment qualification uses private effective configuration and separately bound
observations. Source tests, a generated configuration record, or a successful health
request do not establish deployment acceptance. Transport identity remains unresolved
until an approved expectation and matching evidence are available.

## Effective configuration

`npm run resolve:deployment-config -- <options>` resolves one instance without
calling the stateful instance loader. Supply all options explicitly:

| Options | Input |
| --- | --- |
| `--binding`, `--binding-root` | Private binding file and its trusted directory |
| `--inventory`, `--inventory-root` | Canonical qFleet inventory file and its trusted directory |
| `--instance-root` | Directory containing `<instance_name>/config.json` |
| `--arc-commit`, `--qfleet-commit`, `--whatsoup-commit` | Source revisions for the qualification context |
| `--run-context-digest` | Digest binding observations to the same run context |
| `--output`, `--output-root` | New private effective-record file and its trusted directory |

The command returns only the record's SHA-256. It uses Python 3 and the existing
durable event writer to create the output with mode `0600`, using directory
descriptors and exclusive publication. The writer creates its normal private lock
file in the output directory and refuses to overwrite an existing record. Errors use content-free codes:
`INPUT_INVALID`, `OWNER_CONFLICT`, `EVIDENCE_STALE`, or `DEPENDENCY_UNAVAILABLE`.
The revision arguments declare the requested context; release/bundle evidence must
independently establish the compatible source revisions before acceptance.

The binding schema is `whatsoup.deployment-binding.v1`:

- `target`: opaque `host_ref`, `user_ref`, and `instance_ref`, plus the selected
  `inventory_host` key and an existing valid `instance_name`.
- `settings`: deployment settings missing from the selected inventory row. Effective
  settings require `uid`, `principal`, `home_root`, `platform: "macos"`,
  `service_manager: "launchd"`, `service_domain: "gui" | "user"`, and
  `token_file_relative`. Optional settings are `healthPort`,
  `launch_agent_plist_relative`, `node_executable`, and `wrapper_executable`.
- `requested`: optional health port and service expectations. These stay separate
  from configured values and never silently replace them.
- `overrides`: optional narrower `limits.timeout_seconds`, `limits.max_bytes`, or
  `limits.freshness_seconds`, each with an explicit nonempty reason. Limits default
  to 5 seconds, 65,536 response bytes, and 300 seconds of freshness. Duplicate,
  unbounded, or unrelated overrides are rejected.

Bindings cannot redefine an inventory-owned setting, even with an equal or null
value. qFleet owns host facts. The resolver consumes the canonical inventory's v1
host projection; qFleet retains ownership of its full collector/scheduling policy.
An instance-owned health port or service setting cannot be replaced by a binding.
Instance, service, and account-expectation validation use the existing WhatSoup
validators. Missing, null, and empty values remain distinguishable in field records.

All input files must be private regular files with one link, owned by the observing
user. Trusted roots and their descendant directories must also be private. Symlinks,
escapes, unsafe permissions, duplicate JSON keys, and changed inputs are rejected.
The existing instance loader still accepts its legacy `0644` inputs; those files
are ineligible for full qualification. The resolver never repairs their permissions.
Ordinary CR whitespace and negative zero are allowed in configuration JSON;
overflowing numbers are rejected. Existing boundary-run JSON canonicalization
remains unchanged.

The private `whatsoup.effective-config.v1` record contains the selected target,
requested and configured values, per-field ownership, raw source digests and file
identity and trusted roots, derivation references, override reasons, and context.
Field addresses use dot notation for identifier keys and JSON-quoted bracket
notation for other keys, so inventory extensions retain unambiguous ownership.
Source files are
observed again before return. These are bounded observations, not filesystem locks
or promises that a named file remains unchanged after the command.

`deploy/scripts/lib/deployment_effective_config.py` consumes this private record.
Callers supply the expected record digest, target, and run context. The reader
checks private file ownership and permissions, source bytes and file identities,
and freshness. It observes every source twice and checks the record and freshness
again before returning. These checks have the same bounded-observation limitation
as the resolver; they do not lock the configuration for a later operation.

## Current integration boundary

The health qualifier distinguishes disclosure from service health and retains the
absent, invalid, and valid credential observations. A safe public envelope cannot
turn an unhealthy authenticated response into healthy service evidence. Its bound
mode accepts `--effective-record-root`, `--effective-record`, and the record digest,
plus every target and run-context field. It uses the existing effective-record reader
before making an HTTP request, so a stale, mismatched, or unsafe record produces an
inconclusive result without a probe. The record supplies the instance and health port;
the CLI does not accept a port or timeout override in bound mode.

`npm run test:deployment-qualification` uses the shared bounded pytest resolver for
the health reader, health qualifier, effective-record reader, resolver integration,
and private record writer. Both declarative local gates and Quality's named
`Deployment qualification source suite` run this exact target. The later BOT ERRORS
full behavioral suite is a separate broader regression layer.

When the qualifier cannot resolve the normal private token source, its legacy
LaunchAgent fallback opens the canonical private LaunchAgents directory through a
no-follow descriptor chain, opens the expected plist by descriptor with no-follow,
and rechecks file and parent identity before using a token. A missing capability,
unsafe file, or observed path replacement leaves the valid credential leg unobserved
without sending an Authorization request.

Complete qualifier/helper/profile bundle pinning, operator-suppression coupling, and
the final receipt evaluator remain integration work. Until those gates are complete,
neither the configuration command nor standalone health qualification can produce
deployment acceptance. Installation, activation, permission changes, and live
configuration changes are separate actions.
