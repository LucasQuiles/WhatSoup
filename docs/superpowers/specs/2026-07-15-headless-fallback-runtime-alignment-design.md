# Headless Fallback Runtime Alignment Design

**Date:** 2026-07-15
**Status:** active — approved for implementation
**Scope:** WhatSoup provider admission, session identity, route reconciliation, capability evidence, and operator-safe failure reporting

## Context

A provider failover can currently preserve the provider's opaque session token without
preserving the provider and execution-policy identity that make that token meaningful.
OpenCode turns also rely on whichever default agent the target account happens to load.
That combination permits a fallback lane to answer in text while every required tool is
interactive, rejected, or otherwise unusable.

The existing health probe proves only that a model can return text. It does not prove
that a headless turn can edit a disposable file and verify it with a shell command. The
runtime also keeps existing managers across fallback-window changes, so the configured
route and the process serving the next turn can diverge after activation or reversion.

The repair must make a usable headless lane an admitted capability, not an assumption.
It must also prevent a provider token from crossing provider or policy boundaries, keep
errors useful after sanitization, and avoid giving client-device commands for work that
must run on the service host.

## Goals

- Bind every admitted turn to one immutable provider, model, execution profile, and
  policy identity.
- Resume only a session row whose complete route identity matches the desired route.
- Select the dedicated OpenCode agent explicitly on operational turns and probes.
- Make fallback eligibility depend on fresh static and dynamic capability evidence.
- Reconcile route changes at the serialized turn boundary without interrupting an
  admitted turn.
- Expose enough redacted health evidence for a fleet controller to prove alignment.
- Guarantee non-empty, bounded, sanitized operator and user error details.
- Prevent runbook path redaction from turning an operator command into a corrupted
  command that a client is encouraged to paste.

## Non-goals

- Treating OpenCode permission configuration as an operating-system sandbox.
- Synchronizing a user's entire OpenCode configuration or agent directory.
- Granting Full Disk Access or other broad TCC permissions for work under the declared
  service workspace.
- Executing representative dangerous commands merely to test a deny policy.
- Replacing qFleet as the private host inventory and convergence authority.
- Publishing incident-specific host, account, credential, or chat identity in this
  repository.

## Decision 1: Immutable Resolved Route

At turn admission, resolve exactly one `ResolvedSessionRoute`:

```ts
interface ResolvedSessionRoute {
  readonly provider: ProviderId;
  readonly model: string | null;
  readonly executionProfile: string;
  readonly policyFingerprint: string;
  readonly routeFingerprint: string;
}
```

`routeFingerprint` is a deterministic digest of the preceding normalized fields. It is
not recomputed inside `SessionManager`. The admitted object drives resume lookup,
manager construction, provider argv, capability lookup, health, and lifecycle writes.

Invariants:

1. A provider session token is opaque and valid only within its provider and route
   fingerprint.
2. The manager serving a turn must report the same route fingerprint as the admitted
   route.
3. Missing or malformed route identity never falls back to provider-blind resume.
4. Requested route and observed active route are recorded separately.
5. `unknown` remains `unknown`; it is never normalized into a pass.

## Decision 2: Provider- and Route-scoped Persistence

Add an additive schema migration after the current schema version:

- `agent_sessions.route_fingerprint TEXT`
- `session_checkpoints.agent_session_row_id INTEGER`
- `session_checkpoints.provider TEXT`
- `session_checkpoints.route_fingerprint TEXT`

Lifecycle operations update checkpoints through the exact agent-session row linkage.
The provider token remains a consistency check, not the cross-table primary identity.
Queries that select active or resumable sessions require provider and route fingerprint.

Legacy rows are fail-closed:

- Link a checkpoint only when exactly one compatible agent row is provable.
- Leave ambiguous or unmatched checkpoints unlinked and non-resumable.
- A legacy manager already running may finish its admitted turn, but a row without a
  reconstructable route fingerprint is not resumed after restart.
- Migration evidence records counts for linked, ambiguous, unmatched, and already-linked
  rows without logging provider tokens.

## Decision 3: Queue-boundary Reconciliation

One reconciler runs before dispatch on the existing serialized turn boundary:

1. Resolve the desired route once.
2. Compare it with `SessionManager.getRouteIdentity()`.
3. If they match, dispatch the turn.
4. If they differ and the manager is idle, end the old manager, release ownership, and
   create a new manager for the desired route.
5. If a turn is active, record pending reconciliation. The current turn finishes and the
   next queue admission performs the replacement.

Fallback activation, chain advancement, manual fallback, reversion, restored windows,
and per-sender route preferences all use this path. No route transition kills an admitted
turn, and no fallback-window change promises to mutate an already-running process in
place.

For spawn-per-turn providers, a clean current-generation exit drains remaining output,
clears watchdog state, and sets the child pointer to `null` while leaving the manager
armed. An exit from a superseded generation cannot clear a newer child.

## Decision 4: Dedicated Headless OpenCode Profile

Operational and probe argv select one configured execution profile explicitly. The
fleet baseline name is `whatsoup-headless`; WhatSoup accepts exactly that reserved name
as configuration and does not depend on the account's `default_agent`. The fleet-policy
package owns the versioned agent artifact. WhatSoup preserves the `agent` map while
merging its MCP/custom-endpoint blocks and never provisions an inline policy.

The profile contract is:

- required workspace reads, edits, and shell verification do not resolve to `ask`;
- interactive question and task delegation are denied;
- external directories are denied by default and only declared instance roots are
  allowed;
- direct privilege elevation, remote shells/copy, repository publication, network-policy
  mutation, and credential/config mutation are denied by dispatcher policy;
- the policy is described as a workflow boundary, not a hard shell sandbox.

Every fresh OpenCode turn, resumed OpenCode turn, static probe, and dynamic canary must
carry the selector exactly once. Unsupported selector syntax or an unresolvable profile
makes the lane ineligible.

## Decision 5: Minimal Child Environment

The OpenCode child receives system essentials, WhatSoup's declared runtime identifiers,
and only the credential required by the selected provider/model route. It does not receive
all common OpenCode provider credentials or unrelated connector credentials.

The runtime receipt records environment key names only. It never records values. When
credential selection is ambiguous, child launch fails closed instead of forwarding a
superset.

## Decision 6: Capability Attestation

Text-model usability remains a separate diagnostic. Headless execution capability needs
two independent proofs keyed by route, policy, and binary fingerprint:

### Static proof

Run the exact selected OpenCode binary's agent-debug surface in pure mode and normalize
the effective policy. Required edit and shell actions must not resolve to `ask` or deny.
The selected agent name and semantic policy fingerprint must match the expected values.

### Dynamic proof

Through the same WhatSoup provider adapter and child environment used by operational
turns, run a bounded canary in a disposable directory. The provider must:

1. edit a prepared sentinel;
2. use a shell command to verify the exact content;
3. emit parseable successful tool events for both operations; and
4. exit within the watchdog budget with its process group reaped.

Assistant text alone cannot pass. A missing tool attempt, unparseable event, timeout,
permission prompt, or stale receipt is `inconclusive` or `blocked`, never healthy.

A harmless deny sentinel may prove dispatcher-level rejection only when the parsed event
shows that the command was attempted and rejected and a marker proves no payload ran. If
the model never attempts the command, the deny result is inconclusive.

Fallback eligibility excludes failed, blocked, stale, missing, or inconclusive capability
receipts. Rollout starts report-only and changes to fail-closed only after fleet policy
normalization and canary evidence exist.

## Decision 7: Health and Parity Contract

The additive health surface exposes redacted values:

- desired and observed route fingerprints;
- active route mismatch count;
- configured and observed execution profile;
- expected and observed semantic policy fingerprints;
- exact runtime version and binary fingerprint;
- capability state, checked-at, expiry, and reason code;
- stale child count;
- provider-scoped resume rejection counts; and
- route reconciliation pending count.

Allowed states are `aligned`, `drift`, `blocked`, `not_applicable`, and
`inconclusive`. A fleet with documented exceptions reports
`converged_with_exceptions`, not `aligned`.

The existing WhatSoup fleet hardening contract is extended from layers A-D with:

- **E — headless execution capability:** explicit profile, static semantic policy, and
  fresh edit-plus-shell canary;
- **F — provider/session/runtime alignment:** provider- and route-scoped resume,
  manager reconciliation, and runtime/policy identity receipts.

WhatSoup owns the redacted parity contract. qFleet owns desired values, host applicability,
deployment authorization, and all-host evidence.

## Decision 8: TCC and Code Identity

The baseline for the declared service workspace is `not_required`. No broad TCC grant is
added merely because OpenCode runs headlessly.

If a future bot needs a protected macOS resource, its capability declaration must name
the TCC service, responsible executable, exact launch context, expected authorization,
and a canary traversing launchd to WhatSoup to the provider. Missing or unstable code
identity blocks only that protected-resource capability; it is advisory when TCC is not
required. qFleet never edits TCC databases directly.

## Decision 9: Operator-safe Errors and Runbooks

Provider/parser/tool errors pass through one non-empty bounded formatter before outbound
rendering. The outbound queue has a final generic fallback so a bullet cannot render with
blank detail.

WhatSoup distinguishes target-host actions from client-device actions:

- A client is never told to run a target-host command locally.
- An operator handoff records target role, target user, working directory, command
  identifiers, and sanitized failure class on the administrative surface.
- If outbound redaction would replace an executable path token, delivery switches to a
  non-command status and the complete command remains on the authorized operator surface.
- The literal redaction placeholder is never presented as pasteable shell input.

## Decision 10: Role-scoped Provider Hooks

Instance provider configuration must distinguish operational bots from development or
test-authoring agents. An operational WhatSoup instance does not load a development-only
test-integrity hook/plugin that can intercept ordinary shell work. A development instance
may load one only through an explicit `enabledPlugins` declaration and remains subject to
its own hook policy.

Health/parity evidence records the requested and observed role/plugin set. A hook denial
on an operation outside the plugin's declared role is a configuration mismatch, not a
provider failure and not a reason to ask the client to run the command. Project-trust
state for CLI allowlists is inventoried by the private fleet controller because it is a
target-user configuration surface; WhatSoup reports only safe preflight failure classes.

## Rollout and Rollback

1. Land detection, persistence migration, explicit profile plumbing, and redacted health
   fields with enforcement report-only.
2. Normalize the canonical headless profile and supported runtime on one canary host.
3. Require static proof, dynamic edit-plus-shell proof, route match, and clean service
   restart evidence on the canary.
4. Expand sequentially to fallback-enabled instances. Stop on the first failed host and
   keep that host on primary with OpenCode fallback disabled.
5. Capture static alignment on every in-scope fleet host and live canaries only where an
   OpenCode fallback is configured.
6. Enable fail-closed fallback admission after the convergence record is complete.

The rollback kill switch disables OpenCode fallback, retires existing OpenCode managers,
and leaves the additive schema intact. A rollback to provider-blind code is not allowed
while mixed-provider rows exist.

## Acceptance Criteria

- A Claude token is never passed to OpenCode resume, or vice versa.
- A route/policy mismatch replaces the idle manager before the next turn.
- An active turn finishes before route reconciliation.
- Every OpenCode operational/probe argv selects the configured profile exactly once.
- OpenCode receives exactly one route credential plus the documented non-secret base
  environment.
- Text-only `OK` cannot satisfy headless capability.
- A real edit-plus-shell canary is required and expires on policy/binary drift.
- Clean spawn-per-turn exit leaves an armed manager with no stale child pointer.
- Blank or fully-redacted errors still produce meaningful non-empty status text.
- Missing, stale, malformed, masked, or skipped evidence is never reported as clean.

## Verification Boundary

Unit and integration tests cover route identity, migration ambiguity, exact-row lifecycle,
argv/environment construction, queue-boundary reconciliation, capability parsing, stale
child ownership, error formatting, and health classification. Release verification also
runs the repository parity, config, source-runtime, documentation, and fail-closed guards.

Live fleet success is not claimed from repository tests. It additionally requires qFleet
canary and all-host evidence from the exact installed runtime and launch context.
