# WhatSoup Fleet Topology & Control Plane — Design

| | |
|---|---|
| Date | 2026-05-09 |
| Status | Design — pending implementation planning |
| Scope | Fleet topology, admin/client roles, plugin-pack bifurcation, linking flow, authority + drift, reliability posture, security boundaries, migration shape. |
| Out of scope | Settings migration framework, public-release readiness, compatibility/deprecation policy. Sibling specs needed. |

## 1. Mission

WhatSoup today is single-machine-first. Each node holds its own config, credentials, and plugin set. There is a fleet abstraction in code, but it is primarily a discovery + telemetry plane, not a management plane. As WhatSoup ships publicly and gets deployed across multiple machines per customer (self-administered, designated-machine, or per-setup-admin variations), the gap is: there is no formal admin/client split, no canonical "fleet under one supervisor" model, and no enrollment flow. Operators today rely on SSH and ad-hoc tooling. That does not scale to a public product where users will not have SSH access to every node and should not need it.

This spec defines the topology, roles, and authority model that future work — settings migration, release readiness, compatibility policy, and ongoing protection-layer enforcement — operates within. It does not design those siblings.

## 2. Topology and roles

**Hub-and-spoke, per fleet:**

- One **admin console** (privileged). Runs on the supervising machine. Sees all linked clients in the fleet. Provides fleet-wide operations (push policy, view aggregate telemetry, initiate fleet-wide actions). Built on the existing WhatSoup console with admin-only panes added via the admin plugin pack.
- One or more **client consoles** (subset). One per managed node. Self-manages local config, devices, and instances. Reports state to admin. Operates fully autonomously: no runtime dependency on admin reachability.
- A **fleet** = one admin + N linked clients. Each client linked to exactly one admin. (Multi-admin per fleet is a v2+ evolution. v1 is single-admin-per-fleet.)

**Roles:**

- **Admin** — supervisory. Owns canonical config in admin-owned domains. Sees fleet-wide state. Issues fleet-wide directives.
- **Client** — autonomous. Self-manages local config in client-owned domains. Surfaces state to admin. Receives advisory directives from admin (normally applies them; can decline in well-defined cases).
- **Standalone** — unlinked node. Runs as both client and admin collocated. Default state for "your machine admins itself" installs. Can later be linked to a separate admin or have other nodes link to it.

**Install posture matrix:**

| Install profile | Default mode | When to use |
|---|---|---|
| Local-first / developer install | Standalone (admin + client both enabled) | Individual operator on their own machine; quick start; single-machine deployments. |
| Managed-node install (public-product) | Pure client (admin plugin disabled by default) | Machines that join a fleet and are administered from a separate admin console. |
| Designated-admin install | Standalone, then promote on first link | A user with multiple machines designates one as admin during setup; other machines later link to it as pure clients. |

Admin and client are the **same WhatSoup binary**. Mode is determined by which plugin pack is enabled.

## 3. Bifurcation via plugin pack

The admin role is delivered as an `admin` plugin pack adding:

- Admin-only console panes (fleet view, linked-client management, fleet-wide operations, drift dashboard, audit log).
- Admin-only API surfaces (linking endpoints, fleet-wide query APIs, directive issuance, drift reconciliation actions).
- Admin-only background workers (telemetry aggregation, drift detection from client reports, directive scheduler).

A pure client = WhatSoup with `enabledPlugins` excluding admin. The client console renders only panes and surfaces that do not require the admin plugin. The existing `enabledPlugins` mechanism in `agentOptions` and `.claude/settings.json` (per `CLAUDE.md`) already controls per-instance plugin loading; admin-pack enablement uses the same path.

For a node that is both admin and client (collocated standalone install), both plugins are enabled; admin panes appear alongside client panes.

There are NOT separate binaries. There is one WhatSoup, with or without the admin plugin loaded.

## 4. Linking flow (enrollment)

WhatsApp-linked-device pattern adapted:

1. Every WhatSoup install starts as **standalone** (developer/local profile) or **pure client** (managed-node profile) per the posture matrix.
2. To link a new client to an existing admin, the admin console generates a short-lived **linking code** (QR + alphanumeric) bound to a one-shot enrollment token.
3. On the to-be-linked node, the operator enters the code in the local console. The node:
   - Reaches the admin via the configured transport (Tailscale tailnet preferred; localhost when collocated; configurable for other topologies).
   - Performs a **mutual key exchange**: each side has an install-time-generated long-lived public key; both sides record the other's key.
   - Admin records the new node in its `linkedClients` registry. Client records its admin in its `linkedAdmin` config field.
4. **Linking codes are short-lived** (minutes). Long-term trust is via the exchanged public keys, not the code.
5. **Delegated-admin (also-admin) role.** Enabling the admin plugin on a linked client is NOT a casual client-side toggle. It is a delegated-admin / failover role that requires explicit primary-admin approval, has a separate permission set distinct from the primary admin, and produces an audit-log entry. Default after linking is **pure client** with admin plugin disabled.
6. **Revocation is eventually consistent and fail-closed for admin-issued actions.** When admin revokes a linked client:
   - Admin records the revocation immediately and removes the client from `linkedClients`.
   - The client keeps running locally; autonomy is preserved (per §6).
   - On the client's next reconciliation attempt with admin, admin rejects the client's reports and any inflight admin-issued directives are no-ops at that client.
   - Client-side detection of revocation transitions the node into "unlinked-from-upstream-admin" state (per §7).
   - A revoked client cannot transparently re-link; a fresh linking flow is required.

**Trust layering:** transport (e.g., Tailscale) provides network-layer auth. The linking exchange and recorded public keys provide app-layer auth. Both must be valid for an admin↔client interaction to be honored.

## 5. Authority model and drift handling

Canonical config ownership is **per-domain**, not blanket.

**Config domains and ownership:**

- **Admin-owned canonical** (admin's record is source of truth):
  - Policy (declared posture per the protection-layer spec)
  - Plugin enablement (`enabledPlugins` per instance)
  - Permissions and role assignments
  - Fleet-wide MCP tool surfaces
  - Deployment-version targeting
  - Linked-client registry
- **Client-owned canonical** (client's record is source of truth; admin observes but does not override):
  - Local hardware paths, mount points, volume identifiers
  - Local device pairing state (WhatsApp link state, transport credentials' pairing)
  - Machine-specific runtime paths (XDG dirs, log paths)
  - Ephemeral health state (current load, in-flight queues, last-error metadata)
  - Transient instance state (per-conversation cursors, retry counters)
- **Negotiated/shared** (per-fleet policy decides):
  - Per-instance config defaults
  - Observability config (log levels, sampling rates)
  - Instance display names

**Drift handling for admin-owned domains:**

When a client's local copy of an admin-owned domain differs from admin's canonical record, the difference is a **proposal**, not active state:

- The client's local edit is recorded locally as a proposal and reported to admin as drift.
- **Runtime enforcement continues to use the last admin-signed policy/config.** A client cannot unilaterally weaken its own permissions or plugin policy by editing locally; the active runtime keeps using the last admin-promoted state until admin reviews and acts on the proposal.
- Admin reviews drift via the admin console and chooses one of:
  - **Promote** — proposal becomes the new admin-canonical and the new admin-signed runtime state. Default for non-sensitive sections (display preferences, instance display names).
  - **Revert** — admin re-signs the previous canonical and pushes it; client's proposal is dropped. Default for sensitive sections (permissions, plugin policy).
  - **Flag/exception** — admin marks this client as legitimately divergent; admin's canonical for this domain is per-client overridden. Used for bespoke deployments.

**Client-owned domains** are freely editable by the client and reported to admin informationally; admin does not promote/revert these.

**Audit trail:** every config change (admin push, client proposal, promotion, revert, exception) is logged with timestamp + initiator + signature.

## 6. Reliability posture

The admin machine is **supervisory, not on the request path**. Concretely:

- Client operates fully autonomously. No runtime dependency on admin reachability for any client-facing service.
- Telemetry buffers locally. Forwarded when admin is reachable.
- Local config edits work normally. Proposals (per §5) accumulate locally and are reported when admin returns.
- Admin-issued directives that have not reached a client queue at admin. The client pulls them on its next reconciliation cycle, OR admin pushes when the client becomes reachable.
- No client-side action blocks on admin reachability. The only thing that cannot happen when admin is offline is operating from the admin console — and the operator is on the admin in that case, so it barely matters.

**Directive integrity envelope.** Admin-issued directives carry:

- A signature from admin's long-lived key (verified by client before any application).
- An idempotency key (client de-duplicates by ID; replays are no-ops).
- A TTL (client drops past expiry; stale directives are not applied retroactively).

Stale or unverified directives are dropped silently and logged in the client's audit trail.

## 7. Security boundaries

**What admin can do:**

- Issue fleet-wide directives (signed, idempotent, expiring per §6)
- View aggregate fleet state and per-client telemetry within configured retention/redaction policy
- Push canonical config in admin-owned domains (per §5)
- Approve linking requests; revoke linked clients (per §4)
- Approve delegated-admin role assignments (per §4)
- Audit history of all admin-side and client-side actions

**What client cannot do:**

- See other clients in the fleet.
- Issue fleet-wide directives.
- Push config to other clients.
- Promote itself to admin without admin approval.
- Bypass runtime enforcement of admin-signed policy in admin-owned domains. (Local edits are proposals, not active state — per §5.)

**What client CAN do:**

- See its own state, configs, and telemetry.
- Edit its own client-owned config domains freely.
- Submit proposed changes to admin-owned domains (visible to admin as drift; runtime continues using last admin-signed state).
- Refuse stale, unverified, or expired admin directives.
- Self-unlink from upstream admin. Self-unlink is a **state transition**: the client becomes standalone/unmanaged; admin marks it disconnected/revoked on next observation; the node loses its managed-client status; it cannot transparently come back as managed without a fresh linking flow.

**Blast-radius limits:**

- **Compromised client** — affects only its own runtime. Cannot push to other linked clients, cannot read other clients' state, cannot issue fleet-wide directives. The fleet stays operational.
- **Compromised admin (live)** — highest-blast-radius failure mode. While the admin's key is valid, the holder can issue arbitrary signed directives to all linked clients in the fleet. **Signatures authenticate the source; they do not bound the scope of what an authentic admin can do.** TTL + idempotency limit only stale and replay damage, not damage from a live compromise. Mitigation is detection (audit trail review, drift anomalies) and recovery (key rotation via re-link from a known-clean admin instance). Operators must treat admin-key custody as the most sensitive credential in the fleet and should consider periodic admin-key rotation as standard hygiene.
- **Unlinked / standalone install** — no fleet implications regardless of compromise.
- **Revoked client** — visible in admin audit; remaining linked clients unaffected.

## 8. Public-product implications

- **Single-tenant per fleet in v1.** Each fleet has one admin, is independent. No cross-fleet data sharing. Multi-fleet support (one user running personal + work fleets on the same machine, or multiple admins per fleet) is v2+.
- **Install scenarios** map cleanly to the user-facing framing of "my machine / designated machine / per-setup admin":
  - *Self-administered* — standalone install on the user's main machine. Admin + client collocated.
  - *Designated-administered* — user has multiple machines and designates one as admin. Other machines install as pure clients and link.
  - *Per-setup-admin (organizational)* — organization deploys WhatSoup; an org-designated machine is admin; user machines are pure clients. Public-product target.
- **Telemetry stance — two layers, distinct policies:**
  - **Product telemetry: NONE.** WhatSoup does not phone home to vendor infrastructure. No usage analytics, error reports, version-check pings, or operational metrics are sent to any third party. The product is fully self-hosted per fleet.
  - **Fleet telemetry (admin↔client): configurable, local to the fleet.** Default: admin sees per-client health summaries, drift reports, and the audit log. Sensitive domains (auth events, message content, transport metadata) are off-by-default and require explicit per-fleet opt-in. Per-domain retention windows and redaction rules are policy controls. Clients always retain the right to see what they are reporting up.
- **No central WhatSoup mothership.** Fully self-hosted per fleet. Releases are GitHub releases; updates are pulled by the operator. Update-channel mechanics are owned by the public-release-readiness sibling spec, not this one.

## 9. Migration path for existing users

Current state: every existing user runs a standalone install. No fleet semantics, no admin/client split, no `linkedClients` registry.

Path forward:

1. **Upgrade preserves standalone behavior.** Existing standalone installs upgrade to v(new) with admin + client plugins both enabled by default. No forced behavior change. The new admin panes appear in the console; users do not have to use them.
2. **No forced migration.** Standalone keeps working indefinitely. Users who never link a second machine never see the multi-machine surface.
3. **Opt-in linking.** When a user wants to bring a second machine into a fleet, they invoke the "Link a new client" flow on their existing standalone (which becomes the de-facto admin). The new machine installs as a pure client and links.
4. **Export/import is not required.** A standalone's config IS already a valid admin-canonical config. Linking propagates relevant admin-owned domains to the new client.
5. **Backward-compatible config schemas.** Any new admin/client metadata is added as optional fields with safe defaults. Existing configs continue to load. Detailed migration mechanics — schema versioning, migration script discipline, multi-version compatibility windows — are owned by the **settings migration framework** sibling spec.

## 10. Out of scope (sibling specs needed)

This doc owns: fleet topology, admin/client roles, plugin-pack bifurcation, linking flow, authority + drift, reliability, security boundaries, migration shape.

Explicitly NOT covered:

- **Settings migration framework** — cross-version config migrations across launchd plists, environment files, instance.json, `.claude/settings.json`, XDG configs. Schema versioning + migration script discipline + rollback semantics. Sibling spec needed.
- **Public-release readiness** — README, install path, license, support model, version policy, public docs site, GitHub release process. Product readiness checklist. Sibling spec needed.
- **Compatibility guarantees + deprecation policy** — public surface vs internal surface, semver discipline, deprecation windows, LTS posture, behavior-change announcement protocol. Sibling spec needed.
- **Protection layer** — declared-posture verification mechanics. Already exists at `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`. The fleet topology defined here is the substrate the protection layer operates within: fleet topology says WHERE policy is distributed; the protection layer says HOW it is verified.

## Glossary

- **Fleet** — one admin + N linked clients, identified by the admin's long-lived public key.
- **Admin** — supervisory role, runs the admin plugin pack, owns canonical config in admin-owned domains.
- **Client** — managed node, runs WhatSoup with admin plugin disabled (or with delegated-admin), self-manages client-owned domains, reports state to admin.
- **Standalone** — unlinked node, runs admin + client collocated. Fleet-of-one.
- **Linked / linked-client** — a client whose long-lived key is in the admin's `linkedClients` registry.
- **Delegated-admin** — a linked client whose admin plugin is enabled with explicit primary-admin approval; carries a distinct permission set from primary admin; recorded in the audit log.
- **Linking code** — short-lived alphanumeric / QR token for one-shot mutual key exchange during enrollment.
- **Drift** — divergence between a client's local copy of a config domain and admin's canonical record. For admin-owned domains, drift is treated as a proposal pending admin review.
- **Proposal** — a client-originated edit to an admin-owned config domain. Recorded locally and reported to admin. Does not change runtime enforcement until admin promotes it.
- **Promotion** — admin action that accepts a client proposal, making it the new admin-canonical and admin-signed runtime state.
- **Revert** — admin action that re-signs the previous canonical and pushes it; a client proposal is dropped.
- **Exception** — per-client deviation accepted by admin; admin's canonical for this domain is per-client overridden.
- **Directive** — a signed, idempotency-keyed, TTL-bound instruction issued by admin for clients to apply.
- **Self-unlink** — client-initiated transition out of a fleet; reverts the client to standalone/unmanaged; requires fresh linking to come back.

## Cross-references

- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` — already-approved sibling for posture verification.
- `docs/security-handoffs/2026-05-09-env-secret-exposure.md` and `2026-05-09-env-secret-exposure-kickoff.md` — credential-handling work; informs the credential-storage sections of the settings-migration sibling spec.
- `CLAUDE.md` — repo overview, instance model, per-instance plugin scoping (the mechanism this design rides on).
- `docs/configuration.md` — current per-instance config schema.

Sibling specs to be written:

- `docs/specs/<date>-settings-migration-framework-design.md`
- `docs/specs/<date>-public-release-readiness-design.md`
- `docs/specs/<date>-compatibility-deprecation-policy-design.md`
