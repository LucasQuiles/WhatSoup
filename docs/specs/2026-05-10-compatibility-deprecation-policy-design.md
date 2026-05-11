# WhatSoup Compatibility & Deprecation Policy — Design

| | |
|---|---|
| Date | 2026-05-10 |
| Status | Design — pending implementation planning |
| Scope | External compatibility contract: public surface definition, semver bump rules, breaking-change criteria, deprecation timeline, migration compatibility window, LTS posture, release-notes structure, public-surface registry, internal-vs-public marking conventions. |
| Out of scope | Public-release readiness (README, install path, license, support model, distribution). Sibling spec needed. Settings migration framework, fleet topology, protection layer — already shipped; this spec depends on them. |

## 1. Mission

WhatSoup is shipping from a single-machine local-tooling shape into a public product across multiple machines per customer. The fleet topology spec defines the shape; the settings migration spec defines the mechanics for evolving config across versions; this spec defines the **external contract** WhatSoup commits to — what existing users can rely on, what's internal, how long old schemas are supported, what counts as a breaking change, and how deprecations are announced.

Without an explicit compatibility contract, every WhatSoup release is a coin flip for downstream users. With one, the migration framework's mechanics translate into predictable user experience.

## 2. Public compatibility surface (v1)

The contract: no ordinary breaking change without a semver major bump and a deprecation window. Security exceptions follow §5.

### 2.1 Public surface

Items in the public surface are bound by this spec's deprecation policy:

- Documented config files and schema fields (`instance.json`, `fleet.json`, `.claude/settings.json`, `agent.json`, `protection.policy.yaml`)
- CLI commands and npm scripts intended for operators
- Deployment artifacts: launchd plist generation behavior, systemd unit template behavior
- MCP/HTTP API contracts exposed to users/tools
- Plugin enablement config and runtime modes (`enabledPlugins`, instance roles, admin/client/standalone modes per fleet topology spec)
- Migration behavior and rollback guarantees (per migration framework spec)
- Console user-visible workflows — at the behavior level (what an operator can do), not the internal component structure

### 2.2 Private / internal

No compatibility promise; can change anytime:

- TypeScript module APIs
- File layout under `src/`
- Internal helper functions and classes
- Console component structure (React components, internal state)
- DB internals except where exposed through documented behavior or migrations
- Undocumented scripts and test helpers

Future developer-extension APIs may be promoted to public, but only via deliberate documentation + registry entry + release-notes announcement (see §10). Until then, all TypeScript APIs are private.

## 3. Versioning scheme

Semantic versioning `major.minor.patch`:

- **0.x.y (pre-stable)** — compatibility is best-effort. Breaking changes still get documented in release notes; migrations are provided where practical.
- **1.0.0** — first stable public operator-facing contract.
- **major** (e.g., 1.0.0 → 2.0.0) — breaking change to documented public surface (§4 defines what counts).
- **minor** (e.g., 1.0.0 → 1.1.0) — additive public capability: new config fields with safe defaults, new APIs, new runtime modes.
- **patch** (e.g., 1.0.0 → 1.0.1) — bugfixes, security fixes, docs corrections, behavior fixes that preserve the public contract.

## 4. Breaking change definition

A change is **breaking** (requires a major version bump) if ANY of:

- Requires manual operator intervention beyond the normal upgrade/restart flow (manual config edit, manual migration script run, manual auth re-entry, manual deploy artifact edit/regen)
- Changes runtime behavior after migration, **even if the migration itself is automatic**
- Removes a documented public surface
- Changes security posture, permissions, or authority model in a way that could affect access or automation

A change is **non-breaking** (minor or patch) ONLY if BOTH:

1. The change is auto-migrated by the framework (per migration spec auto-apply tier), AND
2. The post-migration observable behavior is **equivalent or purely additive**

Auto-migration alone does NOT grant non-breaking status. Behavior preservation must hold too. This guardrail closes the "we auto-migrated it" loophole.

**Restart is not breaking by itself.** A long-running service legitimately needs a restart on upgrade; the breaking-change criterion is "manual intervention beyond the normal upgrade/restart flow." Operators expect to restart after `npm upgrade` or equivalent.

**Auto-regenerated deploy artifacts are not breaking** if they preserve behavior. Deploy artifacts that the migration framework regenerates non-destructively (per the deploy_artifacts domain in the migration spec) don't trigger breaking. Breaking applies when an operator must manually edit or regenerate deploy artifacts, OR when behavior changes post-regen.

### Examples

**Minor (non-breaking):**
- Config shape changes that auto-migrate non-destructively AND preserve observable behavior
- New defaults that apply only to new installs (existing installs keep their values)
- Additive API fields, additive config fields, additive CLI options
- New runtime modes added alongside existing ones

**Major (breaking):**
- Removing a config field (even auto-migrated) if the post-migration behavior differs
- Changing a default value in a way that affects existing installs' observable behavior
- Removing a CLI flag or npm script
- Changing API response shape
- Changing the permission model in a way that affects access or automation

## 5. Deprecation timeline

**Default deprecation window:** at least **2 minor releases OR 6 months, whichever is longer**, before a public-surface feature can be removed.

Process:
1. Mark deprecated in release notes and docs.
2. Emit runtime/operator warnings where feasible.
3. Keep supported for at least the default window.
4. Removal happens **only in a major release**, even after the deprecation window passes — security exception aside.

**Window constraints:**
- The window CAN be extended on a per-feature basis with explicit release-note disclosure.
- The window MUST NOT be shortened below the default unless invoking the security exception.

### 5.1 Security exception

A dangerous public surface can be disabled or removed faster than the default window only with ALL of:

- Explicit release-note justification — what the danger is, why faster removal is necessary
- Migration guidance — what operators should do
- Safest-available compatibility shim — a temporary alternative path that preserves operator workflows where feasible

The security exception is the only path to break the default. It must not become the routine path; using it requires documenting why ordinary deprecation was insufficient.

## 6. Migration compatibility window

**Default:** WhatSoup auto-migrates from any schema version with a contiguous migration chain to current, **matching the deprecation window** (2 minors OR 6 months back).

**Per-domain opt-in for longer support:** specific domains can extend their auto-migration window beyond the default if release notes and the migration spec explicitly say so. Good candidates: `instance_config`, `health_tokens` — domains where users have meaningful historical investment.

**Floor:** no domain may have a SHORTER migration window than the default unless invoking the security exception.

**Failure mode for too-old configs:** if a user is past the auto-migration window for any domain, WhatSoup **refuses to start** with an **actionable upgrade path**. Example error:

> "Your `instance_config` is at schema v3. Current WhatSoup supports auto-migration from v5 onward. Upgrade first to v1.8 (the last release supporting v3 → v5), run migrations, then upgrade to current."

No silent failure. No partial-migrate attempts. Clear path forward.

## 7. LTS (long-term support) posture

**v1 explicitly does NOT include an LTS promise.**

- Security fixes land on the current supported line, not on backported old majors.
- Users are expected to stay within the supported migration/deprecation window.
- At v2.0, the LTS posture is revisited based on real adoption signals: install count, operational burden, evidence that users are pinned to old majors, whether backporting is practical.

**Anti-overclaim guard:** WhatSoup must NOT be marketed as enterprise-supported, LTS-supported, or backported-supported unless this policy changes. Release notes, README, install pages, and any marketing material must reflect the rolling-release reality. Public-surface registry entries and release-notes templates enforce this by structure (no "LTS" label exists in the templates until policy changes).

## 8. Release notes structure

Every release MUST include a release-notes document with all six labels explicitly populated. Empty sections must contain the literal string "None this release" rather than be omitted — this forces explicit thinking through each category before publish, and makes "no breaking changes" a positive assertion rather than an absence.

Mandatory labels:

- **Breaking changes** — what changed; what operators must do
- **Migrations** — what auto-applied; what required `--write`; what manual actions are needed; migration IDs
- **Deprecations** — features now marked deprecated; scheduled removal version; recommended alternative
- **Public surface additions** — new public-surface entries promoted in this release (per §10 promotion path); new entries added to the public-surface registry
- **Security fixes** — CVE / advisory references; severity; affected versions; fix details
- **Operator action required** — top-level boolean field PLUS a section. The boolean is parseable by tooling and CI. The section explains what action, if any, the operator must take.

Each item includes file paths and migration IDs where relevant for traceability.

### 8.1 Top-level metadata field

Every release-notes document includes a top-level YAML/JSON metadata block parseable by tooling and guards:

```yaml
operator_action_required: true | false
breaking_changes: true | false
deprecations_added: true | false
security_fixes: true | false
public_surface_additions: true | false
```

The boolean fields enable downstream tooling (CI, release dashboards, deprecation feeds) without requiring NLP on the free-text body.

## 9. Public-surface registry

The registry is the source of truth for "what's public." It lives at `docs/public-surface.md` and is the manifest of every documented public artifact.

### 9.1 Registry entry shape

Per public-surface entity:

- **Identifier** — stable, dotted-namespace identifier (e.g., `config:instance_config:auth.token`, `cli:npm-run-migrate`, `mcp:tools.knowledge.search`, `runtime:mode.standalone`)
- **Type** — config field, CLI command, npm script, MCP/HTTP API, deploy artifact, runtime mode, console workflow
- **Current schema version** — where applicable (e.g., for config fields tied to a domain version)
- **Status** — `active`, `deprecated`, `removed-in:vN`
- **Deprecation notice link** — release-notes anchor where the deprecation was announced (if deprecated)
- **Removal-target version** — the major version in which removal is scheduled (if deprecated)

### 9.2 Registry as a migration domain

The registry is its own migration domain — `public_surface_registry` — added to the seven domains from the migration framework spec. **The registry is NOT folded into `protection_policy`** — different ownership and semantics:
- `protection_policy` declares posture rules for the protection layer to enforce.
- `public_surface_registry` declares external-contract obligations for this spec to enforce.

This brings the migration framework's domain count to eight: `instance_config`, `fleet_config`, `plugin_settings`, `agent_settings`, `deploy_artifacts`, `health_tokens`, `protection_policy`, `public_surface_registry`.

### 9.3 Registry as source of truth (with bootstrap caveat)

After the v1 baseline cut, the registry is the sole source of truth. If something isn't in the registry, it's internal regardless of where else it appears.

**Bootstrap caveat:** until the initial registry baseline is complete (planned for v1.0.0 — the same release that makes this policy active), existing documented surfaces appearing in any of:

- `docs/configuration.md`
- `docs/tools.md` (MCP tool reference)
- `docs/runbook.md`
- Existing release notes (pre-v1)
- The fleet topology + protection-layer specs' explicitly-public artifacts

are **presumed public** and inherit deprecation policy protection. After the v1 baseline cut, the registry alone determines public status; surfaces not migrated from documentation into the registry by v1.0.0 lose presumption-of-public.

### 9.4 Registry CI linting

CI checks for drift between documentation and registry. Two modes:

- **Pre-baseline mode (advisory, until v1 registry baseline is cut):** CI warns when documentation references a surface not in the registry, or registry references a surface not in documentation. Reports drift; doesn't fail the build.
- **Post-baseline mode (required, after baseline):** CI fails the build on documented-but-not-in-registry or registry-without-documentation drift. The registry becomes a hard contract.

The transition from advisory to required mode is gated on an explicit "registry complete for v1" milestone tracked in this spec's changelog.

Release-notes generation reads the registry to populate the deprecations section automatically. Updates to the registry require a release-notes entry under "Public surface additions" or "Deprecations" as appropriate.

## 10. Internal-vs-public marking conventions

To prevent accidental public commitments to internal code:

### 10.1 Per-surface conventions

- **TypeScript modules** under `src/` are private by default. Modules deliberately exposed to external consumers (extension authors, plugin authors) must be in a designated public path (`src/public/`) AND listed in the public-surface registry. Until developer-extension APIs are formally promoted (post-v1), this directory is empty.
- **Config schemas** — only fields documented in `docs/configuration.md` and listed in the public-surface registry are public. Undocumented fields in config files are internal even if they appear in `instance.json` or other artifacts.
- **CLI commands** — only commands documented in the public CLI reference are public. Undocumented `npm run *` scripts are private (test-only scripts, internal release tooling, build scripts).
- **HTTP/MCP APIs** — only endpoints documented in the public API reference are public. Internal admin/console APIs not in the public API reference are private.

### 10.2 Promotion path (internal → public)

1. Add to the public-surface registry with current version
2. Document in the relevant reference (configuration, CLI, API)
3. Add release-notes entry under "Public surface additions"
4. Account for the new public commitment in future deprecation planning

### 10.3 Promotion is one-way

Once public, the surface is bound by this spec's deprecation timeline. **No silent un-promotion** to internal — an existing public surface must follow the full deprecation path even if the project later regrets making it public. The only paths to remove are:

- Standard deprecation cycle (deprecate, wait, remove in major)
- Security exception (justified faster removal with shim)

There is no "we made a mistake, this is internal again" escape hatch. Get the public commitment right before promoting.

## 11. Out of scope (sibling specs)

This spec owns: public-surface definition, semver bump rules, breaking-change criteria, deprecation timeline, migration compatibility window, LTS posture, release-notes labels structure, public-surface registry, internal-vs-public marking conventions.

Explicitly NOT covered:

- **Public-release readiness** — README, install path, license, support model, public docs site, GitHub release process, version-numbering operationalization, distribution channels, telemetry policy. Sibling spec needed (last of the four context docs).
- **Settings migration framework** — already shipped at `docs/specs/2026-05-09-settings-migration-framework-design.md`. This spec depends on it (the breaking-change definition uses migration-relieved logic; the public_surface_registry is added to that framework's domain list).
- **Fleet topology + control plane** — already shipped at `docs/specs/2026-05-09-fleet-topology-control-plane-design.md`. This spec depends on it (the public surface includes admin/client/standalone runtime modes from there).
- **Protection layer** — already shipped at `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`. This spec doesn't override its semantics; the protection-policy domain has its own public-surface entries and is governed by this spec's deprecation policy.

## Glossary

- **Public surface** — features WhatSoup commits to maintaining per this spec's deprecation policy.
- **Private / internal** — features outside the contract; can change anytime without notice.
- **Breaking change** — a change that requires a major version bump per §4 criteria.
- **Deprecation** — public-surface feature marked for removal; supported through the deprecation window.
- **Deprecation window** — minimum supported time from deprecation notice to removal: 2 minors OR 6 months, whichever longer (default).
- **Migration window** — schema versions back from current that auto-migrate; matches deprecation window default; per-domain extensions allowed.
- **Security exception** — narrow path to break the deprecation default; requires release-note justification + migration guidance + safest-available shim.
- **Public-surface registry** — manifest at `docs/public-surface.md` listing every public-surface entity. Source of truth post-baseline-cut.
- **Bootstrap caveat** — pre-v1.0.0 transitional rule: existing documented surfaces are presumed public. After v1.0.0, only registry entries are public.
- **Promotion** — internal → public transition for a surface; one-way, requires registry entry + documentation + release-notes announcement.

## Cross-references

- `docs/specs/2026-05-09-fleet-topology-control-plane-design.md` — fleet topology defines admin/client/standalone modes the public surface includes
- `docs/specs/2026-05-09-settings-migration-framework-design.md` — migration framework whose tiers define "auto-migrated" for the breaking-change definition; `public_surface_registry` is added to that framework's domain list
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` — protection layer whose policy artifact is in the public surface and governed by this spec's deprecation policy
- `docs/canonical-status-policy.md` — internal doc-state policy (different scope; doesn't conflict)
- `docs/configuration.md` — current config reference; will be migrated to follow the public-surface registry pattern by v1.0.0
- `docs/tools.md` — current MCP tool reference; will be migrated similarly

Sibling spec to be written:

- `docs/specs/<date>-public-release-readiness-design.md` (last of the four context docs)
