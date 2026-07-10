# Safe Initialization, Capability, Lifecycle, and Recovery Remediation

Date: 2026-07-09

Status: approved design direction; implementation requires a separately reviewed plan

Source baseline: `origin/main@7330bafb`

Related local repair heads: #1714 `b8ccbfa5`, #1715 `43dd61c5`, #1716 `3c9ae883` plus uncommitted review work, #1717 `3b570a73` plus uncommitted review work

## 1. Decision

WhatSoup will repair the affected surfaces as a sequence of small, fail-closed changes rather than ship either unintegrated MCP candidate unchanged or combine the findings into a runtime rewrite.

The decisions are:

1. Keep Claude's strict per-chat MCP mode. A strict session must receive one complete, policy-compiled configuration rather than rely on plugin discovery outside that configuration.
2. Fix per-chat session ownership before expanding the Microsoft 365 capability surface.
3. Replace arbitrary instance-declared MCP launch records with repo-owned capability descriptors for the first release. A descriptor compiles launch identity, authorization aliases, credential delivery, binding, expected tools, backend proof, and provider support together.
4. Keep required-capability credential values out of model-readable configuration, argv, logs, and the model process environment. A narrowly scoped server launcher resolves an allowlisted credential reference only for the MCP server process.
5. Treat `pending`, absent, malformed, stale, timed-out, and unknown evidence as non-ready. Only explicit, fresh capability proof is ready.
6. Use the existing BOT ERRORS outbox and dispatcher as the durable incident authority. Do not add a second provider-reauth incident file.
7. Preserve #1714 and #1715 as independent repair lanes. They may progress only on their own verification evidence and do not unblock capability deployment.
8. Do not treat the observed candidate Agent365 backend as the effective Microsoft backend until the selected instance's non-secret endpoint provenance is captured. Its stale/HTTP-503 state is not deployment-ready.

These decisions supersede the earlier intention to repair #1717 in place and deploy its generic `additionalMcpServers` surface.

## 2. Evidence and constraints

The design is based on the 2026-07-09 initialization/lifecycle review and its focused falsifiers. The important evidence is restated here so this tracked specification does not depend on ignored review artifacts.

| Evidence | Status at review | Design consequence |
|---|---|---|
| Live Claude per-chat config contained only `whatsoup` while argv used `--strict-mcp-config` | Observed live metadata plus source trace | Strict mode stays; its generated config must contain the complete required surface |
| Claude documents that strict mode ignores other MCP configurations | External primary-source contract | Plugin enablement cannot repair an omitted strict-config server |
| Claude plugin tools use a plugin-qualified callable namespace | External primary-source contract | Authorization must compile every effective plugin/direct identity from one logical tool policy |
| The #1717 candidate's direct Microsoft namespace was absent from all 108 current mutation-deny aliases | Focused deterministic falsifier | #1717 is blocked until namespace policy is compiled, not copied |
| The #1717 candidate resolved keyring values and serialized them in generated JSON | Source trace plus focused validator falsifier | Raw `env` and config-time secret resolution are not part of the replacement public surface |
| `/new` removed the manager from `chatSessions` before `SessionManager.handleNew()` respawned it | Map detachment reproduced; real-child impact source-inferred | Ownership and generation checks land before capability expansion |
| Crash notification cleanup removed the inactive manager before its scheduled respawn | Composed runtime harness reproduction | Notification cannot own lifecycle cleanup |
| The live-gate candidate converted `pending` plus missing required tools to `ready` | Focused deterministic falsifier | Pending blocks until proof or timeout; live/deploy policy share one comparator |
| Core health, fleet polling, diagnostics, and cutover each accept some absent/malformed/stale evidence as green | Source and existing-test trace | Readiness becomes an explicit evidence contract consumed by every surface |
| A candidate Agent365 backend was active but stale and returned HTTP 503; effective `MS365_HUB_URL` was not captured | Sanitized read-only observation | Backend binding remains an explicit deployment input, not an inference |

External contracts:

- Claude CLI `--strict-mcp-config`: <https://code.claude.com/docs/en/cli-reference>
- Claude MCP loading, plugin namespaces, and environment references: <https://code.claude.com/docs/en/mcp>

## 3. Goals

1. Ensure every live child has exactly one discoverable owner and one current generation through reset, crash, respawn, route change, and shutdown.
2. Restore required Microsoft 365 read capability to the exact strict per-chat session without broadening mutation authority.
3. Make the effective server/tool namespace, provider adapter, conversation binding, backend endpoint, and evidence freshness observable without exposing secrets.
4. Make provider-reauth alerts and clears restart-safe without duplicating durable incident state.
5. Give runtime gating, `/health`, fleet polling, diagnostics, cutover, and deploy probes the same readiness verdict for the same evidence.
6. Keep each implementation slice small enough that its red invariant and rollback are obvious.

## 4. Non-goals

1. No wholesale runtime/session rewrite.
2. No general-purpose arbitrary MCP command, argument, or environment public API in the first replacement for #1717.
3. No Microsoft mutation enablement. The first surface is read-only and denies all known mutation aliases regardless of legacy rollout flags.
4. No production mutation to test a deny rule. Denial is proved with fake/test adapters or an independently enforced non-mutating boundary.
5. No claim that static declaration, file serialization, process spawn, or HTTP liveness alone proves capability.
6. No assumption that the observed candidate host is the selected backend or that an active service is healthy.
7. No GitHub branch update, merge, service restart, configuration mutation, or deployment as part of the design/specification phase.

## 5. System invariants

The implementation must preserve all of these invariants:

### I1 — Single owned generation

For each per-chat map key, at most one child generation may be active or respawn-eligible. Every event, crash callback, timer, notification, queue, tracker, socket, and generated config is checked against both manager identity and generation before it may mutate state.

### I2 — No active off-map manager

A manager cannot spawn or retain a child after its owner entry is removed. Owner removal is terminal and follows awaited/bounded child, timer, queue, tracker, socket, and owned-file cleanup.

### I3 — Complete strict surface

When strict MCP mode is enabled, the exact provider-consumed configuration contains WhatSoup plus every required external capability for that provider/mode tuple. Other plugin, user, or project MCP sources are not counted as evidence.

### I4 — Policy follows logical capability

Required tools, read/mutation classification, deny rules, hook matchers, allowlists, discovery names, and health expectations derive from one logical capability descriptor. A new rendered namespace cannot appear without its policy aliases appearing in the same compilation result.

### I5 — Secret-free parent surface

Credential values never appear in instance config, generated provider config, argv, logs, diagnostic payloads, model-process environment, or committed fixtures. Configuration contains only allowlisted credential references and non-secret endpoint metadata.

### I6 — Pending is not ready

Only fresh evidence that the exact server connected, exposed the required tools under the compiled namespace, enforced the required authorization posture, and reached a healthy backend may produce `ready`.

### I7 — One durable incident authority

BOT ERRORS outbox/dispatcher state is authoritative for alert incidents. In-process state controls retries and transition suppression only; it is disposable and may start at `unknown` after every process restart.

### I8 — State changes follow durable acceptance

An alert/clear producer may persist a throttle, mark an incident closed, or suppress future work only after the event is durably queued. A legacy helper accepting a process spawn is explicitly unconfirmed and cannot drive those transitions.

### I9 — Same evidence, same verdict

Runtime gating, health, fleet, diagnostics, cutover, and deployment probes consume the same state taxonomy and conformance cases. No consumer may reinterpret missing, malformed, stale, or pending evidence as green.

### I10 — Safe rollback

Every implementation branch can be reverted without data migration or secret recovery. Generated files are owned and disposable; durable BOT ERRORS events remain compatible with the existing dispatcher.

## 6. Delivery graph and branch boundaries

The work is deliberately split. A later lane cannot be merged merely because its local tests pass; its dependency rows must already be integrated and reverified on the then-current main.

| Lane | Scope | Dependency | Required disposition |
|---|---|---|---|
| Existing A | #1714 redaction repair | Independent | Keep current repair branch; use its fresh release verification before any remote update |
| Existing B | #1715 health/profile repair | Independent | Finish an unmasked full release gate before any remote update |
| R | #1716 provider-reauth durability/parity | Current main plus reviewed #1716 commits | Remove the bespoke incident store; implement the outbox state machine below |
| L | Per-chat lifecycle ownership B1/B2 | Fresh current main | Must land before capability expansion |
| C | Canonical capability descriptor and policy compiler | L | No live enablement; read-only Microsoft descriptor and security fixtures only |
| H0 | Existing false-green removal | Fresh current main | Fail closed for malformed fleet HTTP 200, absent/stale runtime/model evidence, diagnostic unknowns, cutover, and recovery-gate exceptions |
| S | Strict composition, credential launcher, binding, and first provider adapter | C + H0 | Enable only provider/mode tuples with exact adapter proof |
| H1 | Capability readiness convergence | S | Extend the H0 classifier/evidence contract across live gate, health, fleet, diagnostics, cutover, and deploy probes |
| D | Canary and deployment | R + L + C + H0 + S + H1 | Owner-authorized, read-only, backend-proven acceptance gate |

Lane L and the existing false-green slice H0 must precede S. Lane R may progress independently because it does not expand a privileged capability. Lanes C, H0, S, and H1 are separate review units; they must not be folded into a single replacement commit for #1717.

The destructive #1717 remote history and the local `3b570a73` candidate are not bases for S. Useful commits are ported selectively onto the dependency branch only after `git range-diff` and `git cherry -v` prove what is being retained or superseded.

## 7. Lane R — provider-reauth incident durability

### 7.1 Authority and state

Do not add `fleet-provider-reauth-incidents.json` or another incident marker. The canonical BOT ERRORS outbox provides durable ordered events, and the dispatcher owns `openIncidents` and idempotent clear suppression.

Each producer keeps only disposable state:

| Producer state | Meaning | Permitted next actions |
|---|---|---|
| `unknown` | This process has not proved whether a prior process opened or delivered an incident | On current failure, queue alert; on fresh recovery proof, queue one idempotent clear |
| `alert_unconfirmed` | Outbox write failed and any legacy acceptance is not delivery proof | Retain failure truth; retry no faster than the bounded retry window |
| `open_queued` | Alert event was durably queued | Suppress duplicate producer transitions; dispatcher owns delivery/dedup |
| `clear_unconfirmed` | Recovery is proven but clear was not durably queued | Retain open/unknown state; retry no faster than the bounded retry window |
| `closed_queued` | Clear event was durably queued | Stop retries until a new failure transition |

On process restart the state returns to `unknown`. A fresh usable primary-model proof therefore queues one idempotent clear even when this process did not observe the alert. The dispatcher suppresses a clear with no matching open incident. Once that clear is durably queued, the producer moves to `closed_queued` and does not emit again during the process lifetime.

### 7.2 Emission result semantics

Stateful callers use the structured `AlertEmissionResult`; they do not use a boolean that collapses durable and legacy channels.

- `status: durably_queued`, production `channel: outbox`: may advance producer state.
- `status: durably_queued`, test-only `channel: sink`: may advance the test state machine.
- `status: legacy_accepted_unconfirmed`: log/observe only; do not persist a throttle, mark an incident open/closed, or delete retry state.
- `status: failed`: retain prior state and retry on the same bounded schedule.

The legacy helper remains an emergency notification side channel. It is not the source of incident truth. `observeAlertEmission` may continue to log its acceptance, but durable state machines must use an explicit `isDurablyQueued(result)` decision.

### 7.3 Retry bound

An outbox failure must not generate an alert/clear attempt every poll interval. The poller records an in-memory `nextRetryAt` per `(instance, source, operation)` and retries no more frequently than `MIN_ALERT_INTERVAL_MS`. A process restart permits one immediate attempt, after which the bound applies again. No retry marker is written to a second durable store.

Alert evidence remains active while retrying. Clear evidence must still be fresh and usable at the retry time; if it becomes stale, the clear is withheld.

### 7.4 Proof and parity

The only provider-reauth clear proof remains a fresh, usable primary-model probe after the incident. Fallback serving, process restart, key presence, stale evidence, or a generic healthy status is insufficient.

TypeScript and Python diagnostics must agree exactly on:

- source and failure class;
- critical asset shape and owner;
- clear code and clear requirement;
- operator action;
- secret/PII redaction.

Privacy tests scan all candidate substrings. A safe operational token appearing before a later real email/secret must not terminate the scan or make the test pass early.

### 7.5 Lane R acceptance

1. No duplicate producer store can overwrite or contradict dispatcher incident knowledge. If canonical dispatcher state is corrupt/unavailable, producer state remains `unknown`, new evidence is still queued durably when possible, and dispatcher health remains non-green rather than being masked by a replacement store.
2. Restart plus fresh primary proof queues exactly one idempotent clear per process.
3. `legacy_accepted_unconfirmed` never advances durable throttle or incident state.
4. Clear failure retains the source and is rate-bounded, not emitted every poll.
5. Alert failure remains retryable and does not suppress itself as delivered.
6. Runtime and fleet emit identical diagnostic fields; Python parity tests match.
7. Multi-match redaction tests include a benign operational token before a real sensitive value.

## 8. Lane L — per-chat lifecycle ownership

### 8.1 Logical owner record

Implementation may preserve the existing maps, but behavior must be equivalent to one owner record per map key:

```ts
interface OwnedSessionGeneration {
  manager: SessionManager;
  generation: number;
  state: 'starting' | 'active' | 'resetting' | 'recoverable_dead' | 'respawning' | 'exhausted' | 'closing';
  respawnTimer: ReturnType<typeof setTimeout> | null;
}
```

The type is illustrative, not a mandate to replace all maps in one refactor. The invariant is that every callback and resource can prove its owner record and generation before acting.

### 8.2 `/new` transition

For per-chat mode:

1. Resolve and verify the currently owned manager.
2. Abort the old turn and stop accepting old-generation output.
3. Mark the owner `resetting`; do not remove it from `chatSessions`.
4. Advance the generation before any replacement resources become visible.
5. Await bounded shutdown of the old child and generation-owned timers.
6. Replace queue/tracker/per-turn state for the same owner key.
7. Spawn the new child while the manager remains discoverable by identity and generation.
8. Mark `active` only after spawn succeeds. On failure, transition to an explicit terminal/retryable state and leave no child off-map.
9. Drop every callback tagged with the previous generation.

The implementation must not call a respawning method on a manager after deleting its map ownership.

### 8.3 Crash and notification transition

On an unexpected child exit:

1. Verify manager identity and child generation.
2. Preserve the owner and crash counter in `recoverable_dead`.
3. Schedule at most one generation-owned respawn timer.
4. Send the user notification without deleting session, queue, socket, config, or timer ownership.
5. When the timer fires, verify the same owner, generation, state, and inactive child before respawning.
6. On success, advance to the new generation and `active`; only then clear recovery alerts after their own durable acceptance rule.
7. On exhaustion, transition to `exhausted`, perform terminal cleanup, and allow the next message to construct a new tracked owner.

Notification delivery is never a lifecycle cleanup signal.

### 8.4 Callback binding

The current fallback from a missing manager identity to a reused map key must not route stale callbacks into a replacement manager. Event, crash, notify, timer, tool-scope, and queue callbacks capture manager identity and generation. A mismatch is logged at debug/warn as appropriate and dropped before any send, database mutation, queue lookup, or state cleanup.

Child stdout/stderr/exit handlers also carry generation identity. Checking only `this.child === child` at exit is insufficient if old stdout can still be parsed after reset.

### 8.5 Lane L acceptance

1. A real `SessionManager` with a fake child proves `/new` has one tracked active generation and zero active off-map managers.
2. Old-generation event and delayed callback falsifiers produce no queue send, state mutation, or cleanup against the replacement.
3. Crash notification followed by scheduled respawn keeps ownership and invokes respawn exactly once.
4. Exhaustion, explicit reset, eviction, and shutdown each remove ownership only after resource cleanup.
5. Crash counters survive recoverable transitions and do not reset because a notification was delivered.
6. Runtime/session suites, typecheck, fake-timer cleanup, open-handle checks, and leak assertions pass.

## 9. Lane C — canonical capability and authorization contract

### 9.1 Public configuration

The first replacement does not publish `additionalMcpServers`. Instead, agent config selects repo-owned descriptors:

```jsonc
{
  "agentOptions": {
    "requiredCapabilitySurfaces": [
      {
        "id": "microsoft_365",
        "endpoint": "https://non-secret-agent365-endpoint.example",
        "credentialRef": "allowlisted-logical-keyring-service"
      }
    ]
  }
}
```

The public key is `agentOptions.requiredCapabilitySurfaces`. Its registry row and configuration documentation land with the implementation that makes it active. The shape requirements are:

- `id` selects a repo-owned descriptor;
- endpoint metadata is explicit and non-secret; validation permits only `http:`/`https:`, rejects URL userinfo, query, and fragment components, and permits plain HTTP only for loopback endpoints;
- `credentialRef` is an allowlisted logical reference, never a value;
- no arbitrary command, raw argv, raw headers, or raw environment map;
- unknown IDs or unsupported provider/mode combinations fail config validation.

Generic custom MCP servers are deferred until they can provide an equally strong typed launch, credential, authorization, and readiness contract.

### 9.2 Descriptor

Each descriptor supplies, at minimum:

```ts
interface RequiredCapabilitySurface {
  id: string;
  serverId: string;
  tools: readonly {
    logicalId: string;
    providerToolName: string;
    access: 'read' | 'mutation';
    requiredForReady: boolean;
  }[];
  credentialStrategy: 'server_scoped_broker';
  backendProbe: { kind: string; freshnessTtlMs: number };
  binding: { actor: 'required'; conversation: 'required' };
  supportedAdapters: readonly { provider: string; mode: string }[];
}
```

The descriptor contains no credential value and no environment-derived policy. It is the single source for generated config entries, expected discovery names, deny/allow rules, hook matchers, server-side read-only settings, readiness hashes, and operator diagnostics.

### 9.3 Namespace compiler

The compiler renders each logical tool into every effective identity used by supported transports, including plugin-qualified and direct-server names. For Microsoft 365, transition tests must prove all 108 current mutation aliases have the expected compiled counterpart and that no compiled mutation alias is absent from the deny floor.

The first release denies both plugin and direct mutation aliases. Read-only server policy is mandatory. Existing parent integration flags or `allowM365Mutations` cannot broaden this descriptor; a future mutation lane requires its own reviewed design and explicit observable authorization.

Compiler output is atomic: configuration generation fails if launch identity, expected discovery identity, and authorization identity do not derive from the same descriptor revision/hash.

### 9.4 Lane C acceptance

1. One logical tool inventory generates config identity, discovery names, denies, hooks, and health expectations.
2. Every mutation alias is denied under plugin and direct namespaces.
3. No existing rollout flag broadens the read-only descriptor.
4. Unknown descriptor, missing endpoint, literal credential-shaped input, raw env, and unsupported adapter combinations fail validation.
5. The descriptor and config key are added to the public-surface registry in the implementation PR, not predeclared by this design-only commit.

## 10. Lane S — secure strict composition and provider proof

### 10.1 Server-scoped credential launcher

The generated MCP config launches a repo-owned, source-manifested helper with a capability ID, instance identity, non-secret endpoint, and logical credential reference. The helper:

1. accepts only registered capability IDs and credential references;
2. resolves the credential at server launch time;
3. sets it only in the MCP server child's environment;
4. invokes the fixed descriptor command without a shell;
5. never prints the value or includes it in errors;
6. exits nonzero if resolution, path validation, or exec fails.

The model provider process receives neither the value nor an interpolated environment variable containing it. Mode `0600` remains defense in depth for generated files, not the credential boundary.

### 10.2 Config ownership

- Per-chat strict configs are wholly WhatSoup-owned, private, atomically written, directory-synced, tagged with owner/version metadata, and removed by generation-owned cleanup.
- Startup removes only stale files bearing valid WhatSoup ownership metadata; unknown/user files are never deleted.
- Shared provider config updates merge the managed server entry and preserve unrelated entries.
- A provider target is never inferred as the user's home merely because no workspace was supplied.
- Validation uses physical paths to detect symlink escapes, but execution preserves the declared executable spelling so argv/alias semantics are not silently changed.
- Every repo-owned executable/script must be an existing regular file with the required executable/readable policy. The first release avoids ambiguous user-supplied path-bearing args by not exposing arbitrary commands.

### 10.3 Exact provider adapter

An adapter is keyed by the actual selected provider, mode, and transport after primary routing, per-chat routing, fallback selection, and sandbox selection. Generated config support alone is not adapter proof.

Before spawn, after final argv/environment/protocol construction, the adapter attests:

- selected provider and mode match a supported descriptor tuple;
- exact provider-consumed config/protocol payload contains the compiled server entries;
- no required-capability secret literal appears in config, argv, or parent environment;
- strict mode points to the attested file;
- expected authorization and binding hashes match the descriptor;
- sandbox artifacts were produced for the selected provider, not the instance default.

The attestation is the final synchronous gate before child creation. Unsupported reachable fallback or dynamic-route providers make the instance config invalid; they do not silently drop required capabilities.

Initial enablement targets only the exact Claude provider/mode tuple proven by the adapter harness. Codex, Gemini, OpenCode, managed API providers, sandbox variants, and other route/fallback tuples remain rejected until each has equivalent evidence.

### 10.4 Conversation binding

The per-chat MCP session carries actor, canonical conversation key, and delivery JID. An explicit binding discriminator distinguishes a conversation-bound session that intentionally retains selected global tools from an unbound global session.

Registry authorization must:

- inject the bound target instead of accepting a model-selected alternate target;
- deny conflicting target arguments;
- deny cross-chat retarget attempts;
- keep memory and other conversation-scoped tools usable for the bound conversation;
- preserve the actor anti-spoofing behavior already proven by QR-247 tests.

The implementation should reconcile the explicit discriminator from local candidate `446f177b` with the newer binding tests from `61e30177`; neither branch is taken wholesale without range comparison.

### 10.5 Lane S acceptance

1. Exact per-chat strict config contains WhatSoup plus Microsoft 365 and no other unintended server.
2. A canary required-capability credential value is absent from config, argv, logs, diagnostics, and parent environment.
3. The launcher passes the canary only to the fake server child.
4. Unrelated shared MCP entries survive managed writes.
5. Crash/reset leaves no owned stale config or server child; unknown files survive cleanup.
6. Provider × mode × route/fallback tests reject every unproven tuple.
7. Exact listed tool names match compiled names; one fake safe read succeeds and every fake mutation alias is denied.
8. Cross-chat retarget tests fail before tool execution.

## 11. Lanes H0/H1 — truthful readiness and health convergence

H0 fixes the false-green behavior that exists without Microsoft capability support. It lands before S so capability expansion cannot inherit a fleet/health layer that already treats malformed or stale evidence as green. H1 then adds the capability-specific evidence and live gate after the exact provider surface exists.

### 11.1 State taxonomy

Every required surface reports one of:

`undeclared`, `resolution_failed`, `serialized`, `spawn_failed`, `pending`, `connected`, `tools_missing`, `authorization_failed`, `backend_unhealthy`, `backend_stale`, `ready`, or `unknown`.

Only `ready` is green. `connected` is an intermediate observation until required tools, authorization posture, binding, and fresh backend proof are present.

### 11.2 Evidence record

```ts
interface CapabilityReadinessEvidence {
  surfaceId: string;
  descriptorHash: string;
  provider: string;
  mode: string;
  state: string;
  expectedTools: string[];
  observedTools: string[];
  authorizationHash: string | null;
  backend: { endpointIdentity: string; status: string; observedAt: string; expiresAt: string } | null;
  binding: { actorBound: boolean; conversationBound: boolean };
  reasonCode: string;
  observedAt: string;
}
```

Endpoint identity is non-secret and sanitized; credentials, headers, responses containing user data, and raw provider output are excluded.

### 11.3 Comparator

One pure TypeScript comparator owns readiness semantics. Cross-language deployment/health code consumes a versioned set of JSON conformance cases generated from that contract. If a Python implementation remains necessary, both languages must pass the same cases in CI.

The comparator requires:

1. descriptor and observed hashes match;
2. exact selected provider/mode is supported;
3. server is connected, not pending;
4. every required compiled tool is observed;
5. read-only authorization hash matches;
6. actor and conversation are bound;
7. backend proof is authenticated, healthy, and within TTL.

Missing fields, invalid types, unrecognized states, incoherent identity, expired evidence, and parse failure return `unknown` or a specific non-ready state.

### 11.4 Consumer behavior

- **Turn gate:** block the first and subsequent turns whenever required evidence is non-ready. If a provider emits only an early pending snapshot, use a later status channel or safe active probe; otherwise time out non-ready.
- **Core health:** separate process/transport liveness from turn readiness. Agent `healthy` requires a runtime snapshot, fresh usable primary-model evidence, and every required capability `ready`.
- **Fleet poller:** validate response schema and instance identity. HTTP 200 with missing/unrecognized/incoherent status is ambiguous/degraded, never confirmed online.
- **Diagnostics:** tri-state evaluation; absent, stale, timeout, and unknown cannot become confirmed healthy.
- **Cutover:** use the canonical readiness verdict, not `connected:true` string matching.
- **Static inventory:** label declaration/path checks as inventory only; never use them to clear or green a live capability.
- **Recovery gates:** dependency exceptions in active modes preserve the unresolved state and emit durable evidence; they do not perform a legacy clear.

### 11.5 Backend proof

The effective endpoint is taken from validated instance configuration and included in sanitized provenance. The readiness probe is read-only and capability-specific. It must distinguish unreachable, auth failure, HTTP unhealthy, stale, malformed, and healthy.

An observed candidate backend cannot satisfy this gate until the instance is proven to target it and its response is healthy/non-stale. A running service with HTTP 503 remains non-ready.

### 11.6 Lane H0 acceptance

1. Core agent health requires a runtime snapshot and fresh usable primary-model evidence.
2. Fleet rejects malformed, missing, non-string, unrecognized, or incoherent HTTP-200 bodies as non-online/non-confirmed.
3. Diagnostic snapshot evaluation is tri-state; absent, stale, timeout, and unknown are not confirmed healthy.
4. Cutover consumes the canonical agent readiness result rather than `connected:true` alone.
5. Recovery-gate dependency exceptions in active modes preserve the unresolved source; invalid configured modes fail validation.
6. Existing tests that lock false-green behavior are replaced with exact negative assertions.

### 11.7 Lane H1 acceptance

1. A table-driven matrix covers every readiness state across runtime gate, health, fleet, diagnostics, cutover, and deploy probe.
2. Pending with missing tools remains blocked and eventually times out non-ready.
3. `{}`, non-string/unknown status, wrong instance identity, malformed HTTP-200 JSON, stale model, absent runtime, stale backend, and backend 503 are all non-green.
4. Exact fresh proof is green in every consumer.
5. Evidence expiry makes the next turn and every health consumer non-ready until revalidated.
6. Docs, source comments, runbook, tests, live gate, and deploy probe state one pending policy.

## 12. Test and verification strategy

Every implementation lane begins by promoting the corresponding captured falsifier into the real branch and reproducing red against the exact integration base. Tests that currently assert false-green behavior are changed only alongside the implementation that makes the new invariant pass.

| Layer | Minimum proof |
|---|---|
| Unit | State transitions, namespace compilation, credential redaction, readiness matrix |
| Composed runtime | Real manager + fake child reset/crash generations; exact final spawn adapter; conversation retarget denial |
| Filesystem | Atomic/private writes, symlink escape rejection, unrelated-entry preservation, owned stale cleanup, no canary secret |
| Cross-language | TypeScript/Python diagnostic and readiness conformance fixtures |
| Test integrity | No skipped/only/weak first-match assertions; production outbox isolation; fake timers and handles restored |
| Release | Typecheck, affected full suites, manifest/public-surface/doc/boundary guards, complete unmasked `verify:release` |

A masked, skipped, environment-broken, or interrupted gate is inconclusive. It is never reported as clean. Source-runtime and BOT ERRORS manifest hashes are updated only after final source changes, then rechecked from the committed tree.

## 13. Rollout and rollback

### 13.1 Pre-deployment acceptance

For the exact instance/provider/chat mode, all applicable rows must be green:

| Gate | Required evidence |
|---|---|
| Lifecycle | Exactly one tracked generation through reset/crash/respawn; no leaked child/socket/config |
| Declaration | Valid canonical descriptor and read-only policy |
| Resolution | Approved paths and credential reference resolve without exposing a value |
| Serialization | Exact config has all managed entries, preserves unrelated entries where applicable, and has no secret literal |
| Launch | Exact selected adapter consumes the attested config/protocol payload |
| Discovery | Required server and compiled read tools observed |
| Authorization | Fake/test safe read succeeds; all fake/test mutations denied; live server read-only posture reported |
| Backend | Effective endpoint provenance captured; authenticated healthy non-stale proof within TTL |
| Binding | Actor, conversation key, and delivery JID match; retarget falsifier denied |
| Incident | Alert/clear transitions require durable outbox acceptance |
| Health | Runtime, fleet, diagnostics, cutover, and deploy probe agree |

### 13.2 Canary

Deployment requires separate owner authorization after code review and release verification. The first canary is read-only, uses the proven Claude tuple, and performs only an approved benign read. No Microsoft mutation is invoked to test the deny floor.

### 13.3 Rollback

Rollback removes the required capability selection or reverts the implementation commit, terminates the owned server child, and removes only owned generated files. It does not delete user MCP configuration or BOT ERRORS incident state. Because credential values were never serialized, rollback requires no secret-file cleanup.

If backend health becomes stale/unhealthy, the system blocks affected turns and reports non-ready; it does not silently fall back to a provider that lacks the required surface.

## 14. Explicit remaining unknowns

These are deployment inputs, not reasons to weaken the contract:

1. The effective live `MS365_HUB_URL`/endpoint binding for the affected instance has not been captured.
2. The cause of the candidate Agent365 backend's stale/503 state has not been diagnosed.
3. Provider adapters beyond the exact initial Claude tuple remain unproven.
4. Production frequency of the broader lifecycle findings beyond B1/B2 remains unknown.
5. The future owner and authorization model for Microsoft mutations is intentionally undecided and out of scope.

## 15. Definition of done

This remediation program is complete only when:

1. #1716 uses no duplicate incident store and passes its durable restart/parity matrix.
2. Lifecycle B1/B2 falsifiers and generation tests pass on integrated current main.
3. A canonical descriptor compiles the complete strict surface and every authorization identity.
4. No credential literal reaches model-readable surfaces.
5. The exact live provider/mode is adapter-proven and conversation-bound.
6. Pending/unknown/stale/malformed states are non-green everywhere.
7. Effective backend binding is proven healthy and fresh without exposing credentials.
8. All affected focused suites, full release verification, manifests, documentation, and test-integrity gates pass without masking.
9. A separately authorized read-only canary passes the full acceptance table.
10. Remote branches are compared with `git range-diff`/`git cherry -v` before any superseding update or deletion, and no merge/deploy occurs without explicit evidence and authorization.
