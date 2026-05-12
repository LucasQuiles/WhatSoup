# WhatSoup Protection Layer — Design

| | |
|---|---|
| Date | 2026-05-08 |
| Status | Design — approved for implementation planning |
| Scope | Generic, deployment-neutral. Operator inventory and transport identifiers are local configuration, not part of this document. |

## 1. Problem statement

A WhatSoup deployment is a moving target. New routes get added, plugins get enabled, instances inherit credentials, ports get exposed for a quick demo and forgotten, firewalls get disabled mid-debug, configs drift across reboots and upgrades. Each of those is, individually, a small thing. Together, they are how a deployment that was secure on day one stops being secure by day ninety — without anyone ever deciding to make it less secure.

Operators today rely on memory, manual audit, and external scanning for this. None of those scale, and none of them survive contact with a busy operator. The deployment carries the security knowledge — what *should* be true — only in the operator's head, and the operator does not run on a 15-minute cycle.

WhatSoup should ship with a reusable protection layer that continuously answers one question:

> **Is this deployment still operating inside the security posture it claims to have?**

This is not primarily a monitor. A monitor watches for failure. A safeguard watches for *deviation from a declared good state*. The distinction matters because the protection layer can only protect what has been declared, and operators must be able to declare it cleanly, version it, and reuse it across deployments.

## 2. Protection goals

1. **Continuously verify posture against a declared policy.** Drift between observed state and the policy must produce an event in bounded time.
2. **Distinguish "host gone" from "everything changed."** A connectivity blip cannot look like a security incident.
3. **Protect the alerting path itself.** A WhatSoup deployment must not be the only witness to its own failure.
4. **Auto-remediate only a closed, owner-approved allowlist.** Everything else is alert-only with a copy-pasteable proposed fix.
5. **Be portable.** Same engine, swappable collector packs and policy profiles. A new WhatSoup deployment runs with a default policy and produces useful protection on day one.
6. **Be auditable.** Every drift, every alert, every auto-remediation is recorded with timestamps and fingerprints. Operators can answer "what changed when, who got told, what acted."

## 3. Non-goals

- General-purpose endpoint detection or response. The protection layer is concerned with declared posture, not behavioural anomaly hunting.
- Outbound-network anomaly detection or data-exfiltration analysis.
- Behavioural surveillance of operators or end-users.
- Replacement for OS-level hardening (firewall, sshd config, OS patching). The protection layer *verifies* hardening; it does not substitute for applying it.
- Active exploitation, credential testing, or third-party probing.
- Self-protection of the engine's own host beyond declared self-checks. A protection-layer host that is itself fully compromised is outside the model.

## 4. Protection domains

The protection layer organises every check into one of five domains. Domains exist so that policy, alerts, mutes, and reports have a stable taxonomy that survives across versions and across collector packs.

### 4.1 Exposure protection

Ensures that HTTP and TCP surfaces — application APIs, health endpoints, admin consoles, WhatSoup instance ports, deployment-layer reverse-proxy rules, public-internet tunneling/funnel rules — are reachable only from the network scopes the policy declares.

Typical drift: a port newly bound to a wildcard address; a tunneling rule pointing at an internal port; an API route that returns 200 to an unauthenticated request when the policy says it should return 401/403; an admin console exposed beyond loopback.

### 4.2 Credential protection

Ensures that secrets — bearer tokens, provider API keys, signing keys, transport credentials — are present where required, absent where forbidden, owned by the right principal, mode-restricted to the right principal, and never readable beyond their declared scope.

The protection layer never reads secret values. It checks presence/absence, file mode, ownership, and (for environment-resident keys) presence/absence on declared processes only.

Typical drift: a secret file's mode widens; a known-good token file disappears; a process inherits a credential its deployment role forbids; a secret-shaped string appears in a tracked source path.

### 4.3 Capability protection

Ensures each WhatSoup instance has only the capabilities its deployment role permits — enabled plugins, MCP tool surface, access mode, transport privileges, provider key allowance.

This domain matters because deployment roles differ in their threat surface (passive vs. autonomous, global-scope vs. chat-scoped, MCP-equipped vs. not) and an instance silently gaining a capability outside its role is a posture regression even if no port and no firewall changed. The role's underlying runtime type (`chat` / `agent` / `passive`) is asserted as part of the role contract — a runtime-type mismatch is itself a violation.

Typical drift: a passive instance gains an enabled plugin; a chat-scoped instance gains a global-tier credential; a sandboxed instance acquires a cross-provider key.

### 4.4 Change protection

Ensures the deployment shape — installed services, scheduled tasks, login items, system-startup mechanisms, deployment configs (reverse proxy, tunneling daemon, init system), package or deploy script content, application route inventories — only changes through declared changes.

Typical drift: a new launch agent or scheduled task appears; a new application route is added without policy update; a deployment config gains a new tunneling rule; a deploy script gains a `chmod 777` line.

### 4.5 Alerting protection

Ensures the alert path itself is alive. Drift events are useless if their delivery is silent. The protection layer's own delivery health is a first-class probe, and a separate watchdog with an independent transport detects engine-down and transport-down conditions.

Typical drift: heartbeat silence past threshold; alert-delivery success rate to zero while drift is occurring; the protection layer's own credentials widen; the watchdog's external transport credential ages out.

## 5. Policy model

### 5.1 What policy declares

A protection policy is a YAML document that declares, for one deployment:

| Field | Purpose |
|---|---|
| `inventory` | The set of hosts, instances, applications, and deployment artifacts under protection. References live in policy, not in code. |
| `domains` | Per-domain enablement and severity tuning. A deployment may opt out of `change` protection on application routes, for example, while keeping it on system services. |
| `deployment_roles` | Per-WhatSoup-deployment-role expectations: underlying runtime type, enabled plugins, provider env requirements, access mode, capability allowlist. |
| `collectors` | Which collector packs to load, with per-pack configuration. |
| `evaluators` | Which evaluators to enable; rule overrides. |
| `mute_constraints` | Maximum mute duration, mute domains that cannot be suppressed (alerting protection always wins), mutes requiring extra confirmation. |
| `actions` | Per-rule action: `observe`, `alert`, `propose_fix`, `meta_alert`, `block`, `remediate`. `block`/`remediate` are reserved at runtime today (see §6.5); when enabled, the remediate set is closed and operator-approved. |
| `transport` | Where alerts go (primary alert sink, fallbacks, meta-alert sink). Identifiers are stable (canonical chat identity), not human labels. |
| `extends` | Optional parent profile (`development`, `personal-strict`, `production`, `customer-managed`). |

#### 5.1.1 Always-on `alerting` domain

The `alerting` domain is self-protection: it covers the engine's own credentials, baseline-HMAC integrity, and transport-failure escalation. It is always-on by construction and cannot be disabled from policy. `tools/whatsoup_guard/src/runner.ts:298-301` short-circuits `isDomainEnabled('alerting')` to `true`, and `tools/whatsoup_guard/src/policy/runtime.ts:46-50` rejects `domains.alerting.enabled: false` at policy-load time with `alerting self-protection must fail closed`. Operators may still tune severity for the domain; they may not disable it.

### 5.2 Profile inheritance

Policies extend a parent profile and override fields. An operator's local config typically looks like:

```yaml
extends: personal-strict
inventory:
  hosts: [...]
  instances: [...]
transport:
  alert_sink:
    conversation_key: "<canonical chat identity>"
```

Inheritance is shallow merge with explicit override semantics — child arrays replace parent arrays unless `merge: true` is set on the field.

### 5.3 Stable identifiers, not human labels

Routing, target identification, and policy references use stable identifiers (canonical IDs, conversation keys, hashes) — not human labels. Human labels are present for logs and UI but never used for routing. This is consistent with WhatSoup's `conversation_key` model: the chat identity stays stable across address aliasing, and the protection layer must inherit that property.

### 5.4 The `extends` chain

```
customer-managed   ← sanitized defaults; no private infrastructure assumptions
production         ← strict; no unauthenticated mutation surfaces; external meta-alert required
personal-strict    ← strong local protections; limited auto-remediation
development        ← permissive; mostly observe-only
```

Profiles are arranged so a more conservative profile is easier to derive from a less conservative one. A deployment migrating from `development` to `production` can do so by changing the `extends` and addressing the per-rule failures the engine surfaces during dry-run.

## 6. Collector / Evaluator / Event Ledger model

The engine is structured as five independent stages, each with a defined input and output:

```
Inventory (from policy)
       ↓
Collectors            — read host/app/repo/deployment state, normalise to canonical JSON
       ↓
Baseline + HMAC       — compare canonical JSON against the signed expected document
       ↓
Evaluators            — apply policy rules, produce drift/info events with severity + fingerprint
       ↓
Event Ledger          — append-only record (sqlite + jsonl); source of truth for everything else
       ↓
Alert Sinks + Actions — primary, fallback, meta-alert; observe / alert / propose_fix / meta_alert (block/remediate are schema-reserved and runtime-rejected)
```

### 6.1 Collectors

A **collector pack** is a versioned module that observes one slice of state and returns canonical JSON. Packs are independent, drop-in, and live under `tools/whatsoup_guard/src/collector/`. Initial packs:

| Pack | Domain coverage |
|---|---|
| `host.<platform>` | OS-level state — listening ports, firewall, persistence mechanisms (launch agents/daemons/timers/cron/scheduled tasks/login items), sshd posture, file modes on declared paths. One subpack per supported platform. |
| `whatsoup.instance` | Per-instance state — auth on declared HTTP routes, instance health response shape, port exposure, declared bearer-token file modes, access mode, enabled plugins. |
| `whatsoup.fleet` | Cross-instance state — fleet API surface, console exposure, MCP proxy routes, instance inventory, agent provider-key inheritance, alert-transport health. |
| `deployment` | Deployment-layer state — reverse-proxy config, tunneling daemon serve/funnel rules, init-system service inventory. |
| `repo` | Repository-tracked state — application route inventory (path → SHA), tracked secret-shape scan (path-only), package and deploy script SHA. |

Collectors are read-only by definition. A collector that needs elevated privilege returns the result of a single, fixed, root-owned wrapper script — not a general shell.

### 6.2 Baseline and HMAC integrity

A **baseline** is an HMAC-signed canonical JSON document per `(probe_id, scope_id)` representing the expected state. Baselines are operator-confirmed (no implicit baseline-on-first-run; first-run captures an attacker's state if any). The HMAC key lives in a mode-restricted file readable only by the engine's runtime principal.

The engine self-checks the HMAC on every cycle. Failed verification on a baseline row emits a `crit` event in the **alerting protection** domain — `baseline_integrity_fail` — and that probe refuses to evaluate drift until the operator re-baselines manually. Closes the trivial "attacker rewrites baseline" path against any actor without the HMAC key.

The HMAC scheme does not protect against full compromise of the engine's runtime principal (which has the key by definition). An off-host signer is an explicit deferred capability; it is documented but not part of the v1 model.

### 6.3 Evaluators

An **evaluator** is a pure function from `(observed_doc, baseline_doc, policy_rules)` to `[Event]`. Evaluators have no I/O; they are unit-testable on fixtures. The split between collectors (do I/O, normalise) and evaluators (rule logic, no I/O) keeps the test surface clean and the rule-logic auditable.

### 6.4 Event ledger

Append-only events table backed by SQLite for query and JSONL for streaming. Every event has at minimum:

```
{ id, ts, kind, domain, scope_id, probe_id, severity, fingerprint, payload, alerted_to }
```

`fingerprint = sha256(probe_id || canonical_diff)`, with `canonical_diff` stripped of timestamps and ephemeral state, so the same drift produces the same fingerprint on every cycle.

Events the ledger records (complete shipped set; see `tools/whatsoup_guard/src/types.ts:9-16`):

`drift`, `drift_dedup`, `drift_muted`, `probe_error`, `baseline_integrity_fail`, `alert_delivery_succeeded`, `alert_delivery_failed`, `alert_delivery_failed_all`, `mute_set`, `mute_expire`, `heartbeat`, `jsonl_mirror_failed`, `self_secret_widened`, `alert_token_aging`, `cycle_refused`, `cycle_failed`.

Operator-visible semantics for the four extras beyond the original draft:

- `jsonl_mirror_failed` — the SQLite event was appended but the JSONL mirror write failed; durability budget is degraded for that event.
- `alert_token_aging` — the alert-sink credential is approaching expiry; routed through `credential.token_aging` to whatever action the policy declares.
- `cycle_refused` — the engine refused to evaluate this cycle because a `crit` self-protection event (e.g. `self_secret_widened`) tripped fail-closed.
- `cycle_failed` — the cycle CLI caught an uncaught error before completing; ledgered as a terminal cycle outcome.

The ledger is the truth source. Alert content is derivable from the ledger; the ledger is never derivable from alerts.

### 6.5 Actions

Six action types, declared per rule in policy:

| Action | Behaviour |
|---|---|
| `observe` | Event lands in the ledger only. No alert, no remediation. Used for low-signal change tracking. |
| `alert` | Event lands in the ledger and is dispatched to the alert sink chain. Default for most drift. |
| `propose_fix` | Same as `alert`, with a copy-pasteable fix command in the alert body. The engine never runs it. |
| `meta_alert` | Event is routed to the external meta-alert transport (`metaAlertSinks`) rather than the primary alert chain. Used for transport-failure escalation; see §7.1. |
| `block` | For pre-action collectors only (`repo.api_routes` on commit, etc.) — blocks the action that would produce the drift. **Declared in the schema but currently rejected by the policy runtime** (`tools/whatsoup_guard/src/policy/runtime.ts:52-58`); reserved for a future revision. |
| `remediate` | Engine invokes a single, fixed, root-owned wrapper script that restores the declared state. Allowlisted only. Both alert sink and the host owner are notified. **Declared in the schema but currently rejected by the policy runtime** (`tools/whatsoup_guard/src/policy/runtime.ts:52-58`); reserved for a future revision. |

In v1 the runtime accepts `observe`, `alert`, `propose_fix`, and `meta_alert`. `block` and `remediate` are part of the schema for forward compatibility and load-time validation but a policy declaring them at any key will fail closed with `unsupported policy action`. The remediation allowlist remains part of policy, not engine code, so when `remediate` is enabled a profile with no `remediate` actions still performs zero mutations. `customer-managed` is such a profile.

## 7. Alerting and meta-alerting

### 7.1 Channel chain

```
1. Primary alert sink   (e.g. WhatSoup /send to a declared conversation_key)
2. Local notification   (engine host's notification surface)
3. Local durable log    (always; never the sole delivery)
4. External meta-alert  (watchdog only; independent transport)
```

Rules:

- The local durable log is audit trail, not delivery. An alert that lands only on disk emits `alert_delivery_failed_all`.
- The external meta-alert channel is reserved primarily for the watchdog (heartbeat silence, transport-failure detection from outside the engine). It is also reachable from inside the engine via the `meta_alert` policy action for events that signal the primary transport itself is broken — most notably `alerting.transport_failed` (raised when `alert_delivery_failed_all` is ledgered). Both paths land on the same `metaAlertSinks` array (`tools/whatsoup_guard/src/runner.ts:612-615`). Routine drift must not be wired to `meta_alert`; doing so burns the channel's signal value.
- Critical-severity alerts retry the primary sink with bounded backoff before falling through. Lower severities are single-shot and fall through.
- The external meta-alert channel is profile-gated. `production` requires it; `development` typically disables it.

### 7.2 Watchdog

A separate process (separate scheduling unit, separate log surface, separate transport credentials) reads the engine's event ledger and detects two failures the engine cannot detect itself:

- **Heartbeat silence** past threshold (engine is not running or is wedged).
- **Alert transport broken** — heartbeats are landing but `alert_delivery_succeeded` rate is zero while drift events accumulate.

Either condition fires a meta-alert via the watchdog's independent transport.

### 7.3 Transport identifiers

Targets are addressed by stable identifier (canonical chat identity, hash, ID). Human labels are preserved alongside for logs and UI but are never used for routing. This rule applies to every transport; switching primary sinks does not change identifier semantics.

### 7.4 Alert content shape

A single alert maps to a single drift event maps to a single fingerprint. No bundles. Alert bodies always include: severity, scope ID, probe ID, structural diff, action taken (`observe` / `alert` / `propose_fix:<command>` / `meta_alert`), fingerprint, copy-pasteable mute command, event ID. Runtime v1 never emits remediation result labels because `block` and `remediate` policies fail closed during runtime config construction.

### 7.5 Storm guard

Critical-severity alerts skip the normal dedup window but rate-limit to one alert per fingerprint per 15 minutes unless the payload or the action result changes. A wrapper looping does not flood the alert sink.

### 7.6 Mute scope

Mutes are timed, reasoned, and scoped to (host, domain). Mutes can never suppress: alerting protection failures (HMAC, heartbeat, transport). Wildcard mutes suppress alerts but do not suppress remediation unless the operator explicitly opts in. Mute expiry posts to the alert sink; the channel knows when monitoring resumes.

## 8. Capability and credential controls

These are the controls that distinguish the protection layer from a generic config monitor.

### 8.1 Per-deployment-role policy

WhatSoup distinguishes a small set of **runtime types** (`chat`, `agent`, `passive` — see `docs/configuration.md`) and a larger set of **deployment roles** layered on top. A deployment role is a named configuration of a runtime type with specific plugins, credentials, access mode, MCP surface, and transport privileges. Different deployments name their roles differently; what matters here is that the protection layer treats roles, not runtime types, as the unit of expected posture.

The protection layer does not assume a single posture across roles; it requires per-role declarations. A passive line has different expectations from an autonomous agent, and policy should encode that explicitly rather than imply it.

For each role, policy declares:

| Field | Semantics |
|---|---|
| `runtime_type` | The underlying runtime type (`chat` / `agent` / `passive`); pulled from the instance's `instance.json` and asserted against the role declaration. Mismatch is a posture violation in itself. |
| `provider_env` | Per-key state (`required` / `forbidden` / `optional`). The engine never reads values; it consults a wrapper that returns presence-only maps. |
| `enabled_plugins` | Allowlist or `enabled_plugins_max` integer. |
| `access_mode` | `open_dm`, `groups_only`, `access` — with `allowed`, `false`, or specific values. |
| `mcp_tool_set` | Optional allowlist of MCP tool names available to the role. |
| `transport_privileges` | Per-role reachability of send/heal/access/mark-read endpoints. |

Drift on these per-role assertions is high-severity, not critical — the criticality bar is reserved for unauthenticated mutation surfaces and public-internet tunneling.

### 8.2 Credential probes never read values

Every credential check is a metadata check: file exists? file mode? file owner? key present in process env (yes/no)? token age? The values are never read into the engine's process memory and never cross the SSH boundary.

For environment-resident keys, the wrapper returns a structure of the shape:

```
[ { instance, pid, role, runtime_type, provider_env: { KEY_NAME: bool } }, ... ]
```

Only WhatSoup-owned processes appear. WhatSoup ownership is detected by union of three signals: command path under a policy-declared allowlist, scheduling-unit label glob match, configured instance health port → PID.

### 8.3 Self-credential hygiene

The engine self-checks its own credentials on every cycle: alert-sink bearer token, baseline HMAC key, watchdog meta-alert provider secret, SSH key for collector access. Mode widening on any of these emits `crit self_secret_widened` in the alerting-protection domain and refuses the next cycle until corrected.

## 9. Deployment profiles

Four reusable profiles ship with the protection layer. Each is a policy YAML in `tools/whatsoup_guard/src/policy/profiles/`.

### 9.1 `development`

Permissive, observe-heavy. Most domains in `observe` action. Used during initial deployment and probe-pack development. No remediation. Local-only alerts. External meta-alert disabled.

### 9.2 `personal-strict`

Strong protections for single-operator deployments. All five domains active. Remediation allowed for a tight allowlist of unauthenticated-exposure rules. Primary alert sink configured; external meta-alert optional.

### 9.3 `production`

The default for deployments serving more than one principal. All five domains active. Unauthenticated mutation surfaces alert at critical. External meta-alert required. Remediation allowed only for rules that have been operator-attested and listed in the profile's allowlist. Mute durations capped tighter than the engine default.

### 9.4 `customer-managed`

Sanitized defaults for deployments operated by a customer of the WhatSoup product. No private infrastructure assumptions: no specific tunneling daemon, no specific scheduling unit names. Remediation entirely off by default. External meta-alert optional. Used as the parent profile for `extends:` chains in customer-managed deployments.

### 9.5 Operator deployment configuration

Operators configure their own deployments by extending a profile in a local config file. The config sets inventory, transport identifiers, and any role-specific overrides:

```yaml
extends: personal-strict
inventory:
  hosts: [...]
  instances: [...]
transport:
  alert_sink:
    conversation_key: "<canonical chat identity>"
```

Operator config is not part of the product. The protection layer ships profiles, collectors, evaluators, and engine; operators ship their own inventory and transport identifiers in local config that the engine reads at startup. Hostnames, network identifiers, account names, and other environment-specific details are operator concerns, not product artifacts.

## 10. Testing philosophy

### 10.1 Determinism over end-to-end

Each layer of the engine is tested in isolation against deterministic fixtures. Collectors are tested by feeding their parser real captured output and asserting normalised JSON. Evaluators are tested by feeding them paired observed/baseline documents and asserting the resulting events. The engine is tested by composing fixture collectors with real evaluators and asserting full-cycle behaviour.

End-to-end tests against live hosts exist but are explicit, gated, and never the primary acceptance signal. A test that requires mutating a real service is a runbook step, not a unit test.

### 10.2 Risky tests are simulator-first

For acceptance tests that exercise drift detection or auto-remediation, the simulator mode is the primary path: it composes fixture collectors that emit pre-recorded drift on demand. Live-host versions of those tests exist for periodic real-world validation but require explicit operator confirmation, a documented recovery path, and a bounded blast radius.

The protection layer never instructs an operator to run destructive commands as part of a test. Risky live tests are documented separately and gated.

### 10.3 No broad mocks

Tests use real SQLite (in-memory or temp files), real Unix sockets where applicable, real HTTP via a local fake-sink. Mocks are reserved for external network endpoints we cannot run locally. The framework is the same as WhatSoup-core's: vitest with a forked pool.

### 10.4 Path-scoped CI

Engine tests run when `tools/whatsoup_guard/**` changes. They do not block unrelated WhatSoup product PRs. Conversely, product PRs do not block engine tests.

## 11. Example policy (sanitized)

A minimal `personal-strict` extension showing the shape of a deployment pack. Identifiers are placeholders.

```yaml
extends: personal-strict

inventory:
  hosts:
    - id: <host-1>
      platform: macos
      collectors: [host.macos, whatsoup.instance, whatsoup.fleet, deployment, repo]
    - id: <host-2>
      platform: windows
      collectors: [host.windows]                    # alert-only on this platform
  instances:
    - id: <instance-1>
      role: <passive-oversight-line>           # deployment role name; runtime type asserted below
      host: <host-1>
    - id: <instance-2>
      role: <autonomous-operator>
      host: <host-1>

deployment_roles:
  <passive-oversight-line>:
    runtime_type: passive
    provider_env:
      ANTHROPIC_API_KEY: forbidden
      OPENAI_API_KEY:    forbidden
    enabled_plugins_max: 5
    access_mode:
      open_dm: false
      groups_only: true
  <autonomous-operator>:
    runtime_type: agent
    provider_env:
      ANTHROPIC_API_KEY: required
    access_mode:
      open_dm: allowed
      groups_only: allowed

actions:
  # v1 supports `observe`, `alert`, `propose_fix`, `meta_alert`.
  # `block` / `remediate` are reserved in the schema (see policy/runtime.ts:52-58)
  # and will be enabled in a future revision; until then the entries below use
  # `alert` so the example loads as-is.
  exposure.unauthenticated_mutation:    alert
  exposure.public_funnel_internal:      alert
  exposure.firewall_disabled:           alert
  capability.role_violation:            alert
  credential.file_mode_widened:         alert
  credential.token_aging:               propose_fix
  change.new_persistence_unit:          alert
  change.new_application_route:         alert
  alerting.self_secret_widened:         alert
  alerting.transport_failed:            meta_alert

transport:
  alert_sink:
    kind: whatsoup
    base_url: <configurable>
    conversation_key: <canonical chat identity>
    token_file: ~/.config/whatsoup-guard/alert-sink.env
  meta_alert:
    enabled: true
    provider: <ntfy | pushover | webhook>
    secret_file: ~/.config/whatsoup-guard/meta-alert.env

mute_constraints:
  default_max_duration: 24h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
```

A `customer-managed` deployment is the same shape with `extends: customer-managed`, no `remediate` actions, and no infrastructure-specific collectors.

## 12. Deployment lifecycle

The protection layer expects every deployment to move through four phases. The product provides the engine, profiles, and verification harness. The operator provides inventory and transport identifiers and runs the lifecycle.

1. **Posture fix.** Whatever hardening the operator's environment requires before the protection layer can baseline an honest "good state." The product does not prescribe these fixes; it verifies them after.
2. **Engine install.** Per-host engine deployment using the platform-appropriate install routine: dedicated runtime principal, command-restricted access, forced-command shim, allowlisted wrappers, platform-equivalent privilege escalation, idempotent uninstall.
3. **Baseline.** Operator-confirmed baseline establishment with dry-run review, then signed commitment. No implicit baseline-on-first-run.
4. **Operate.** Cadence, observability, escalation, rollback. Inventory and transport are operator config, not product code.

Engineering artifacts (this design, the implementation plan, the engine source) carry no inventory, hostnames, IPs, account names, group identifiers, or one-off application names. Those are operator concerns, expressed in local configuration the engine reads at startup.

---

*End of design.*
