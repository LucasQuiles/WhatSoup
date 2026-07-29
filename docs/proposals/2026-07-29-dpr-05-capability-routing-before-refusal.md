# feat(agent): specify capability routing before refusal

**Status:** DRAFT feature-request specification for owner review — documentation
only; no build authorization is claimed, and this pull request must not be
treated as queue-ready.
**Grounding:** operator-local sealed evidence run (2026-07-28); repository
claims re-verified at pinned `origin/main` `c9759467d`. Citation legend:
`[mining run (operator-local): …]` points into the sealed mining addendum
retained outside the repository (per-source filenames neutralized to
`source-NN`); `[verified at pinned main c9759467d]` marks path/symbol claims
re-verified at that commit; `[issue survey …: #N]` marks GET-only issue/PR
survey attribution; `[design relay 2026-07-28 (operator-local): …]` marks
attributed design-relay leads, advisory unless independently verified.


| Field | Value |
|---|---|
| DPR ID | DPR-05 |
| OPP mapping | OPP-05 |
| Tier | B |
| Adjudication verdict | `admit_as_protocol_and_registry_specification` |
| Evidence class | frontier-only; advisory-only worker evidence |
| Provenance | missed-affordance mining admission + attributed QPI amendment |
| Pinned live-main SHA | `c9759467d297787f2e0eb2739bd6cd38ea09145c` |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

There is no per-source admission or chat citation for this request. The evidence is an admitted cross-source frontier plus advisory-only worker analysis, so it supports a protocol and registry specification, not a claim that a particular refusal was wrong or that alternate routes are equivalent. The mining run recorded `new_pr_candidates: 0`; this local draft does not alter that result. [mining run (operator-local): evidence/cross-source-opportunity-frontier.json::cross_cutting_design_opportunities[id=OPP-05]] [mining run (operator-local): workers/capability-routing-sanitized.md::Scope] [mining run (operator-local): manifest.json::result.new_pr_candidates]

The target behavior is bounded: before asserting inability, resolve sanctioned routes that are equivalent in identity, authorization, target, freshness, runtime, and mutation class. If no equivalent route is proven, return the narrow blocker, the maximum safe partial result, and one concrete unblock path. A later success under different authority does not retroactively make an earlier refusal false.

## Systems, schemas, APIs, runtime paths, and docs touched

The mining phrase “capability registry” maps partly—but not completely—to the shipped `src/mcp/registry.ts#ToolRegistry`. `ToolRegistry` provides tool registration, listing, and calling; `ToolDeclaration` carries scope, target mode, replay policy, sensitivity, and group metadata. The broader resolver also needs authorization, credentials, provider/runtime descriptors, config gates, endpoint state, and live probes, so it must not rename or conflate those surfaces with `ToolRegistry`. [verified at pinned main c9759467d]

Verified inputs include `registerAllTools`, `createCapabilityGrantManager`, workspace/sandbox controls, provider descriptors, command requirements, turn-control capabilities, routable pin targets, primary-model probes, and credential probes. `src/core/profiles.ts` models outbound identity and is an input to identity matching, not a capability registry. [verified at pinned main c9759467d]

Implementation should add:

- `src/core/capability-resolver.ts` for pure resolution and precedence.
- `src/core/capability-types.ts` for predicates, observations, verdicts, freshness, and route plans.
- adapters over `ToolRegistry`, provider/runtime descriptors, capability grants, config, credentials, sandbox policy, and endpoint probes.
- an internal read-only resolver API used by the agent path before inability language.
- bounded route-decision events compatible with DPR-04 when available.
- a capability-routing contract document with ownership, cache invalidation, and refusal semantics.

## Proposed data and control flow

A requested capability is a typed predicate: operation, target kind, required identity, authorization scope, mutation class, freshness bound, runtime constraint, and result shape. A route observation records its source, observed time, expiry, and proof status; it never upgrades an unknown value to available.

The canonical verdicts are `available`, `unsupported`, `unavailable_config`, `unavailable_authentication`, `unauthorized`, `policy_denied`, and `probe_inconclusive`. Deny-wins precedence is:

| Priority | Condition | Verdict |
|---|---|---|
| 1 | Explicit policy deny | `policy_denied` |
| 2 | Authorization deny | `unauthorized` |
| 3 | Identity or scope mismatch | `unauthorized` |
| 4 | Configuration disabled | `unavailable_config` |
| 5 | Authentication or credential unavailable | `unavailable_authentication` |
| 6 | Live probe failed, stale, or inconclusive | `probe_inconclusive` |
| 7 | Registered and all required checks pass | `available` |
| 8 | No declared route | `unsupported` |

No allow, model inference, cache hit, or fallback may override an earlier deny. The deny-first verdict-matrix shape is adapted from the attributed QPI relay; WhatSoup’s own authorization and policy surfaces remain authoritative. [design relay 2026-07-28 (operator-local): cc-re-borrow-adapt-reject-matrix.md#PermissionRequest-hook-verdict-matrix-deny-wins]

Resolution proceeds:

1. Parse the request into a capability predicate without broadening its mutation scope.
2. Enumerate only registered, session-visible tool and provider routes.
3. Join route declarations with identity, grants, policy, config, credential/auth, runtime, and target state.
4. Apply deny-wins precedence before any probe.
5. Run bounded, non-mutating live probes where static data cannot establish availability.
6. Reject routes that are not equivalent in identity, permission, target, freshness, runtime, or mutation class.
7. Select the least-privileged exact route; otherwise return a typed blocker, safe partial result, and unblock path.
8. Emit a bounded decision receipt, or a local trace until DPR-04 is available.

## Prerequisites and dependencies

DPR-05 is a hard prerequisite for DPR-06 because proactive offers must not advertise unavailable or unauthorized routes. DPR-04 is a soft dependency for durable route-decision receipts; routing can ship with bounded local traces first.

Owners must designate an authorization SSOT and a policy SSOT before enforcement. Tool registration alone is not authorization, credential presence is not capability, and probe success is not permission.

The resolver requires an inventory of each adapter’s freshness guarantees and safe probe. Any surface without a non-mutating probe remains `probe_inconclusive` unless static evidence is sufficient.

## Implementation slices and sequencing

1. Define predicate, observation, verdict, and route-plan types with deny-wins table tests.
2. Build adapters for `ToolRegistry` declarations and session-visible registration.
3. Add identity, grant, sandbox/policy, config, credential, and provider/runtime adapters.
4. Add bounded live probes with deadlines, freshness, provenance, and circuit breakers.
5. Run shadow resolution before existing inability responses and record disagreement without changing behavior.
6. Add the typed blocker/partial-result/unblock response contract.
7. Enable route selection for an allowlisted set of read-only capabilities.
8. Expand only after detector validation, authorization review, and successful-twin tests.

Cache keys must include capability predicate, instance, identity, authorization scope, target, and mutation class. Authentication, config, registration, or policy changes invalidate affected entries immediately; time-based expiry is a fallback, not the sole invalidation mechanism.

## Security, privacy, authorization, and retention

The resolver cannot bypass existing tool guards, sandboxing, capability grants, provider authorization, or target restrictions. It narrows candidate routes and explains blockers; execution still passes through each route’s native authorization checks.

Probe contracts must be read-only, bounded, rate-limited, and explicit about side effects. A probe that can send, schedule, create, mutate, authenticate, or refresh credentials is not a probe and requires the normal authorization path.

Decision traces retain route identifiers, verdict classes, freshness, and policy rule references only. They must not contain credentials, raw tool arguments, message content, identities, provider-specific chat identifiers, or probe response bodies. Access and retention follow the stricter source record.

## Migration and backward compatibility

This is initially an in-process protocol with no required persistent schema. Additive configuration introduces `advanced.capabilityRouting` with `enabled`, `shadow`, allowlisted capability families, probe deadlines, and cache TTL bounds; `InstanceConfig` and the validator must own the same shape.

Existing `ToolRegistry.list()` and `call()` behavior remains stable. Group metadata may become an adapter input, but this draft does not change group semantics or treat groups as authorization. Unknown providers and older tool declarations produce `probe_inconclusive` or `unsupported`, never an implicit allow.

If DPR-04 is present, emit its versioned route-decision events. Without it, use bounded ephemeral diagnostics; absence of a receipt must not change the verdict.

## Failure, recovery, and observability

Resolver failure returns `probe_inconclusive` with a narrow explanation; it must not fabricate `unsupported`, silently choose a broader route, or erase a policy deny. Timeouts and circuit-open states preserve the last observation only if it is still fresh and its policy/config dependencies have not changed.

Metrics should cover verdicts by capability family, probe latency/outcomes, cache age, invalidations, shadow disagreements, selected-route execution outcomes, and refusal-to-later-success review pairs. They must not be presented as service-failure prevalence.

Every decision trace records requested predicate, candidate count, eliminated-route reasons, selected route reference, freshness, and the final response class. Sensitive values are excluded.

## Test matrix and acceptance criteria

All seven mined detector families—`capability_route_gap`, `continuity_context_repayment`, `action_artifact_frontier`, `recurring_work_automation`, `user_self_service_transfer`, `decision_readiness_gap`, and `durable_multimodal_continuity`—remain `enforcement_ready: false`. No detector advances to enforcement until precision, recall, blind-review agreement, policy coverage, and known failure modes are documented on representative positive, negative, borderline, and false-positive samples. [mining run (operator-local): evidence/detector-controls.json::detectors[*].enforcement_ready + advancement_rule]

| Case | Required proof |
|---|---|
| Exact authorized route | selected route matches identity, permission, target, freshness, runtime, and mutation class |
| Policy conflict | explicit deny wins over registration, cache, and probe success |
| Auth missing | result is `unavailable_authentication` with no credential disclosure or login side effect |
| Stale or failed probe | result is `probe_inconclusive`, not `unsupported` |
| Non-equivalent later success | earlier decision remains correctly classified |
| Genuine boundary | safe partial result and one concrete unblock path are returned |
| Successful twin | alternate sanctioned route is selected before inability language |
| Borderline and false-positive controls | limitation wording or manual completion alone does not prove a route gap |
| Cache invalidation | auth, config, registration, identity, and policy changes invalidate the relevant route |
| Execution recheck | native route authorization can still deny after selection, and that denial is preserved |

Acceptance requires full precedence-table coverage, no deny-overridden cases in randomized tests, bounded probes with deterministic deadlines, and shadow evidence sufficient for owner review. It does not require or permit detector enforcement.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #1976 owns server-side MCP tool-surface progressive disclosure. DPR-05 may consume its disclosure metadata, but capability resolution includes authorization and live state and must not absorb that issue’s surface-reduction work. [issue survey 2026-07-28: #1976]

Issue #2408 owns alerting distinctions between failed probes, missing tools, and expected runtime inventory. Its typed distinctions should be reused, while conversational pre-refusal routing remains DPR-05’s scope. [issue survey 2026-07-28: #2408]

Issue #2121 includes brittle model-pin routing and post-handoff behavior. DPR-05 may consume the verified routable-pin contract, but it does not own session rehydration or rewrite that issue. [issue survey 2026-07-28: #2121]

Issue #2554 owns schedules accepted on a transport that cannot execute them. DPR-05 should prevent such a route from being advertised as available, while scheduler retry and transport fixes remain in that issue. [issue survey 2026-07-28: #2554]

A separate waiver or permission proposal would remain distinct from capability discovery. Its live owner and scope require a fresh survey before publication.

## Unresolved decisions, alternatives, and non-goals

Unresolved decisions are which component owns final verdict composition, how frequently each live probe may run, whether partial-result generation belongs in the resolver or response planner, and which read-only capability families enter the first allowlist.

An alternative is prompt-only tool introspection. It is rejected for enforcement because it cannot guarantee deny-wins ordering, freshness, or typed equivalence. Another alternative is extending `ToolRegistry` into the entire resolver; that would conflate registration with authorization and runtime state.

Non-goals are bypassing controls, auto-authentication, credential refresh, route execution inside probes, claiming every later success proves an earlier refusal wrong, replacing `ToolRegistry`, changing profile semantics, or using detector output as an enforcement label.

## Rollout, feature flags, and rollback

Ship behind `advanced.capabilityRouting.enabled`, default `false`, with `shadowOnly=true` initially. Independently gate probes, response annotations, and route selection; start with allowlisted read-only predicates.

Promotion requires deny-wins security review, live-probe budgets, cache-invalidation proof, successful-twin and false-positive evaluation, and the detector advancement rule above. Until then, the resolver is advisory and existing execution authorization remains unchanged.

Rollback disables route selection first, then response annotations and probes. Shadow diagnostics may remain only if retention and privacy controls pass; resolver unavailability must yield an inconclusive internal state, never a stronger refusal claim or a broader execution path.
