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
inconclusive result without a probe. It reads the record and its source inputs again
after the observation; a changed record cannot produce an accepted health receipt.
The record supplies the instance and health port;
the CLI does not accept a port or timeout override in bound mode.

`npm run test:deployment-qualification` uses the shared bounded pytest resolver for
the health reader, health qualifier, effective-record reader, resolver integration,
private record writer, bundle verifier, and real bundled CLI boundary. Both declarative local gates and Quality's named
`Deployment qualification source suite` run this exact target. The later BOT ERRORS
full behavioral suite is a separate broader regression layer.

When the qualifier cannot resolve the normal private token source, its legacy
LaunchAgent fallback opens the canonical private LaunchAgents directory through a
no-follow descriptor chain, opens the expected plist by descriptor with no-follow,
and rechecks file and parent identity before using a token. A missing capability,
unsafe file, or observed path replacement leaves the valid credential leg unobserved
without sending an Authorization request.

## Bound qualification bundle

The health CLI also accepts `--bundle-root`, `--bundle-manifest`, and
`--bundle-sha256` together with all effective-record binding arguments. The
`whatsoup.qualification-bundle.v1` manifest binds the source commit, compatible
ARC/qFleet commits, deployment policy version, execution directory, qualifier,
and the exact file closure with SHA-256 and executable flags. The manifest stays
outside the execution directory. Paths are relative and cannot escape the export.

The execution directory must contain the qualifier, both deployment profiles,
`runtime-test-qualification.json`, and the loaded health-reader, durable-JSON,
effective-config, and bundle-verifier helpers under `lib/`. The source-test profile
is copied from `docs/operations/runtime-test-qualification.json` in the same source
export. File presence alone does not establish that its commands ran. The qualifier
checks the loaded helper paths and the selected health profile against this closure.
Symlinks, hard links, unexpected files, bytecode, changed file identities, and hash
drift are refused. Inclusive traversal limits are 64 entries, 32 files, 16 directories
including the root, depth 4, 1 MiB per file, and 2 MiB total regular-file bytes.
The CLI refuses an external Python bytecode-cache prefix before importing project
helpers; `-B` alone prevents cache writes but does not prevent cache reads.
Malformed or excessively nested bundle JSON produces a content-free refusal.

Bundle validation precedes the health requests and runs again after them. Successful
bound health observations include only the bundle/effective-record digests, source
context, and opaque target references in `bundle_binding`; a failed recheck emits
`bundle_unavailable` and no binding. These are bounded observations, not a filesystem
lock or a guarantee against subsequent changes. The qualifier and helpers retain
their runtime-manifest pins; no operator exemption is introduced.

### Export from a committed source

The maintained `release:export` command can include the bundle in its staged,
exact-commit release. Supply the compatible revisions and complete source selection
explicitly; the command does not infer compatibility from a sibling checkout:

```sh
npm run release:export -- --commit "$SOURCE_COMMIT" --release-root "$RELEASE_ROOT" \
  --qualification-bundle --qualification-source-commit "$SOURCE_COMMIT" \
  --qualification-arc-commit "$ARC_COMMIT" \
  --qualification-qfleet-commit "$QFLEET_COMMIT" \
  --qualification-policy-version whatsoup.deployment-qualification-profile.v1 \
  --qualification-qualifier deploy/scripts/qualify-health-deployment.py \
  --qualification-source-test-profile docs/operations/runtime-test-qualification.json \
  --qualification-deployment-profile deploy/scripts/health-deployment-qualification-profile.json \
  --qualification-deployment-profile deploy/scripts/deployment-qualification-profile.json \
  --qualification-health-helper deploy/scripts/lib/health_reader.py \
  --qualification-health-helper deploy/scripts/lib/durable_json.py \
  --qualification-health-helper deploy/scripts/lib/deployment_effective_config.py \
  --qualification-health-helper deploy/scripts/lib/deployment_qualification_bundle.py \
  --json
```

The export contains `qualification-bundle.json` and the execution closure under
`deployment-qualification/`. Its JSON result includes the manifest path and SHA-256
under `qualificationBundle`. The ordinary release manifest also covers these files.
Uncommitted changes are excluded; missing required commit inputs prevent publication.
An exported bundle is an artifact, not evidence that source tests or deployment
qualification passed. Required source acceptance and compatibility evidence must
still bind the same immutable revisions before use. Exporting onto a live host,
installing, activating, and changing service selectors remain separate operations.

The final deployment evaluator remains integration work.
The currently declared `arc.observation.v1` input still needs a validated producer
contract carrying target, source, run context, bundle, effective configuration,
freshness, and required-area evidence. Generic verification records or unbound
collector observations cannot stand in for that contract. Neither source tests nor
standalone health qualification establish deployment acceptance. Installation,
activation, permission changes, and live configuration changes are separate actions.
