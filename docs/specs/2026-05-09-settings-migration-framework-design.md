# WhatSoup Settings Migration Framework — Design

| | |
|---|---|
| Date | 2026-05-09 |
| Status | Design — pending implementation planning |
| Scope | Per-domain config and deploy-side migration framework: versioning, ledger, trigger tiers, migration definition shape, snapshots, rollback, cross-domain orchestration, multi-version chains, testing discipline. |
| Out of scope | Compatibility / deprecation policy, public-release readiness, DB schema migrations (existing framework, separate lane), provider keychain migration mechanics (covered by the credential-handling kickoff), protection-policy semantics (covered by the protection-layer spec). Sibling specs needed for the first two. |

## 1. Mission

WhatSoup ships from single-machine local-tooling shape into a multi-machine fleet product (per the fleet topology spec). Existing users have launchd plists / systemd units, `tokens.env`, `instance.json`, `.claude/settings.json`, per-instance XDG configs, and (with the fleet topology spec) admin/client metadata. When schemas change, every existing user must come along smoothly: no lost credentials, no re-authentication, no manual plist regeneration.

Existing patterns prove the discipline works: the memory-config migration (`scripts/migrate-memory-config.ts`, `src/config-memory-migration.ts`) is non-destructive with `--write` for explicit apply; DB schema migrations (`src/core/database.ts`) are auto-applied with a `schema_migrations` ledger. This spec **generalizes those patterns** for the new domains and the cross-domain coordination upcoming work will need.

The framework's job is to make existing-user upgrades smooth on safe migrations and require explicit consent on risky ones, while never losing credentials, never breaking existing deployments, and always leaving a recovery path.

## 2. Scope

**IN scope** — config-side and deploy-side user-settings surfaces (the seven domains in §3).

**OUT of scope**, with cross-references rather than absorption:

- `bot.db` schema migrations — existing `schema_migrations` table in `src/core/database.ts`. Continues in its own lane. Cross-domain migrations may declare DB-side dependencies; the DB framework itself is unchanged.
- DB content migrations (data-shape changes within an existing schema, not schema bumps).
- Provider keychain migration mechanics — `docs/security-handoffs/2026-05-09-env-secret-exposure-kickoff.md` owns the credential-migration discipline. The `health_tokens` domain in this framework handles the migration of token storage; the broader credential-handling pattern lives in that doc.
- Compatibility / deprecation policy — what schema versions WhatSoup commits to supporting in the wild, deprecation windows, behavior-change announcement protocol. Sibling spec needed.
- Public-release readiness — install scripts, release process, version numbering policy, support model. Sibling spec needed.

## 3. Domains and ownership

Seven domains:

| Domain | Source-of-truth artifact | Canonical owner |
|---|---|---|
| `instance_config` | `<configRoot>/<instance>/config.json` | **mixed by section** — local hardware paths, device pairing state, machine-specific runtime paths are client-owned; instance role, plugin enablement, MCP tool surface are admin-owned (per fleet topology spec) |
| `fleet_config` | `<configRoot>/fleet.json` (admin only) | admin-owned canonical |
| `plugin_settings` | `<configRoot>/<instance>/.claude/settings.json` + `enabledPlugins` in `agentOptions` | admin-owned canonical |
| `agent_settings` | section of `instance.json` or `<configRoot>/<instance>/agent.json` | **mixed by section** — admin owns runtime config; client owns local-runtime constraints (hardware specifics, machine paths) |
| `deploy_artifacts` | OS-specific (`~/Library/LaunchAgents/com.whatsoup.*.plist`, `~/.config/systemd/user/whatsoup@*.service`, wrapper scripts) | per-machine, regenerated from a templated source |
| `health_tokens` | currently `<configRoot>/<instance>/tokens.env`; target = OS keyring | per-instance, admin-issued |
| `protection_policy` | `<configRoot>/protection.policy.yaml` (per protection-layer spec) | admin-owned canonical |

Authority semantics align with the fleet topology spec's per-domain canonical-ownership model. Migrations on admin-owned domains run from admin context (admin issues the migration; clients apply on their next reconcile). Client-owned domain migrations run locally on each client. Per-machine domains (`deploy_artifacts`) are regenerated locally from a templated source the framework provides.

### Coordination with protection-layer baselines

Migrations affecting the `protection_policy` domain or any other state that protection-layer baselines have signed (per `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` section 6.2) require coordinated re-signing. Without explicit re-signing, the next protection-layer cycle will emit `baseline_integrity_fail` and refuse to evaluate that probe.

A migration touching protected state MUST either:
1. Include a re-sign step after the apply phase that updates the baseline HMAC against the new state, OR
2. Surface a `protection_baseline_resign_required` warning in the migration ledger entry so an operator can re-baseline manually.

This coordination is per-domain and does not auto-fire: protection-layer ownership of baseline integrity stays with the protection layer, and the migration framework only annotates that re-signing is needed.

For mixed-ownership domains, each migration declares which sections it touches; section-level ownership routing determines whether the migration runs admin-side, client-side, or both.

## 4. Versioning and ledger

### 4.1 Source-of-truth versioning

Each domain artifact carries an embedded `_schemaVersion` field (or equivalent for non-JSON formats):

- JSON artifacts (`config.json`, `fleet.json`, `agent.json`, `.claude/settings.json`): `"_schemaVersion": N` field at the root.
- Plist artifacts (launchd `.plist`): a `<key>SchemaVersion</key><integer>N</integer>` entry.
- Systemd units (`.service`): a `# SchemaVersion=N` comment in the unit's standard comment block.
- YAML artifacts (`protection.policy.yaml`): a `_schemaVersion: N` top-level key.
- `tokens.env`: **does not** carry an embedded version (parser tolerance varies). Instead, the `health_tokens` domain tracks version via a sibling `<configRoot>/<instance>/tokens.metadata.json` until the migration to keyring completes; afterward, the OS keyring is the new artifact and metadata moves with it.
- Generated `deploy_artifacts`: include a comment recording the **template version** they were generated from. Authoritative version is the **template source**, not the generated artifact alone. If the generated artifact's recorded template-version is out of date relative to the current template, the framework regenerates.

**The artifact's embedded `_schemaVersion` is the source of truth for "what version is this domain currently at."** The ledger is audit history, not source of truth. If the artifact's embedded version and the ledger's implied current-version disagree, that is a **migration-integrity error**: the framework refuses to proceed and surfaces the inconsistency for operator action.

### 4.2 Per-machine migration ledger

Per-domain history at `<configRoot>/.migration-ledger/<domain>.jsonl`. Each line is a JSON record:

```json
{
  "domain": "instance_config",
  "from": 2,
  "to": 3,
  "migration_id": "instance_config__2_to_3__add_fleet_metadata",
  "applied_at": "2026-05-09T22:00:00Z",
  "snapshot_id": "snap_2026-05-09T21:59:58Z",
  "status": "succeeded",
  "trigger": "auto",
  "duration_ms": 142
}
```

Ledger is **append-only**. A migration is never re-applied; the framework enforces idempotency at the framework level by checking the ledger before apply.

Cross-domain migrations get a parent `migration_id` with sub-records in each touched domain's ledger linked via `parent_migration_id`.

### 4.3 Ledger states

- `started` — migration has begun applying; snapshot exists; the artifact may be in transition state
- `succeeded` — migration applied AND post-checks passed (parse + version + checksum + semantic invariants)
- `failed_post_check` — migration applied but post-checks failed; auto-rollback triggered for auto-apply tier
- `rolled_back` — migration was applied then explicitly rolled back; references the rollback's own ledger entry id
- `failed_rollback` — rollback attempted but failed; framework surfaces this for operator escalation

Status transitions only forward through this set: `started → {succeeded | failed_post_check} → rolled_back → {failed_rollback or terminal}`.

## 5. Trigger model

Every migration declares its tier as either **auto-apply** or **operator-gated**. The framework's response to malformed or unsafe migrations is the **hard-fail outcome** — not a tier authors choose.

### 5.1 Auto-apply tier (boot-time, non-destructive)

Boot-time application without operator intervention. Includes:

- Add optional fields with safe defaults
- Populate default values for new fields (idempotent)
- Copy/mirror values into a new location (without removing the old)
- Add schema version metadata (the `_schemaVersion` bump)
- Write snapshots before any other migration runs

Constraint: must be reversible by snapshot restore alone. If a migration's effects can't be undone purely by restoring the pre-migration snapshot, it is not auto-apply tier.

### 5.2 Operator-gated tier (requires `--write` flag)

Explicit operator action via the migration CLI. Includes:

- Delete fields or files
- Rewrite launchd or systemd units (regenerate from template)
- Remove `tokens.env` (only after keyring path is proven; gated on the credential-handling kickoff's terminal-phase discipline)
- Modify credential stores
- Rotate or revoke keys
- Change admin/client authority state (linkedClients registry edits, key rotation)

Constraint: must produce a `dryRun()` output before applying. The CLI shows exactly what will change. Operator confirms with `--write`.

### 5.3 Hard-fail (framework outcome, not author tier)

The framework refuses to load or apply a migration when:

- Metadata is missing (no `from_version`, no `to_version`, no `migration_id`, no `tier`, no `description`)
- Rollback metadata is missing or insufficient (no snapshot capability AND no custom `rollback()` AND tier requires rollback)
- Scope is undeclared (migration would touch artifacts outside its declared `touches` list — framework detects this at apply via filesystem instrumentation in dry-run)
- Migration would touch secrets directly without a dry-run output
- Migration cannot snapshot the affected artifact (file not present, permissions denied, format unparseable)
- Version chain is malformed (gap, conflict, cycle)
- Migration declares cross-domain `touches` AND `tier: auto-apply` (cross-domain is always operator-gated; see §8)

Hard-fail surfaces a structured error pointing at the migration definition; framework refuses to start the boot sequence (for boot-time auto migrations) or refuses to run the CLI (for operator-gated). Operator must fix the migration definition.

## 6. Migration definition shape

Each migration is a TypeScript module at `src/migrations/<domain>/<migration_id>.ts`:

```ts
import { addDefaultField } from '../_helpers.ts';
import type { Migration, MigrationContext, DomainState, DryRunReport } from '../_types.ts';

export const migration: Migration = {
  id: 'instance_config__2_to_3__add_fleet_metadata',
  domain: 'instance_config',
  from_version: 2,
  to_version: 3,
  tier: 'auto-apply',                  // or 'operator-gated'
  touches: ['instance_config'],         // single-domain or cross-domain list
  description: 'Add admin/client fleet metadata fields with safe defaults',

  async apply(input: DomainState, ctx: MigrationContext): Promise<DomainState> {
    return addDefaultField(input, ['fleet', 'role'], 'standalone');
  },

  // Required for operator-gated; recommended for auto-apply
  async dryRun(input: DomainState, ctx: MigrationContext): Promise<DryRunReport> {
    return { changes: [['fleet.role', 'standalone (default)']], removes: [], renames: [] };
  },

  // OPTIONAL. Default rollback path is snapshot restore.
  // Custom rollback() only when snapshot restore is insufficient (rare).
  // If present: must be dry-runable, idempotent, test-covered.
  async rollback?(input: DomainState, ctx: MigrationContext): Promise<DomainState> {
    return removeField(input, ['fleet', 'role']);
  },
};
```

### 6.1 Typed helpers

`src/migrations/_helpers.ts` provides reusable, tested helpers for common transformations:

- `addDefaultField(state, path, defaultValue)` — additive, idempotent
- `mirrorField(state, fromPath, toPath)` — copy without removing
- `renameField(state, fromPath, toPath)` — move and remove old; operator-gated
- `removeField(state, path)` — delete; operator-gated
- `bumpSchemaVersion(state, target)` — set `_schemaVersion` to a specific value

Common migrations are 5–10 lines using helpers. Complex migrations use raw TypeScript. The existing `migrateLegacyMemoryConfig` in `src/config-memory-migration.ts` becomes the prototype function-based migration.

YAML manifest support is **deferred** until helper repetition proves painful. Avoiding a DSL surface keeps the security review smaller for v1.

### 6.2 Validation

Framework loads all migrations at startup, validates:

- Each migration's metadata is complete
- For each domain, the `from_version → to_version` chain is contiguous (no gaps), non-conflicting (no two migrations claiming the same `from → to`), acyclic
- Each migration's tier matches its actual behavior (static analysis where possible; dry-run analysis at runtime)
- Cross-domain migrations have valid `dependsOn` graphs

Validation failures produce hard-fail outcomes with specific error messages.

## 7. Snapshot and rollback mechanics

### 7.1 Snapshots

Written to `<configRoot>/.migration-snapshots/<domain>/<snapshot_id>/`:
- Full byte-copy of affected artifact(s)
- `metadata.json` with: timestamp, source `migration_id`, pre-migration `_schemaVersion`, sha256 of each captured file, list of file paths captured
- gzip compression for files >1KB; raw otherwise

### 7.2 Credential-bearing snapshots — strong default

**Default: do NOT snapshot credential values.** A migration that doesn't need to read credentials must not include them in its snapshot. The migration's `touches` declaration governs scope; framework enforces it.

If a migration explicitly needs to snapshot credentials (rare; e.g., a token format change that requires a rollback path):

- Encrypt the snapshot with a per-snapshot symmetric key. The key is stored in the OS keyring under a snapshot-specific service entry (`whatsoup-snapshot-<snapshot_id>`).
- **Ledger records snapshot id and non-secret metadata only.** Sensitive key material / key references stay in protected snapshot metadata or in the keyring, never in the ledger.
- The migration tier MUST be `operator-gated` regardless of other characteristics.
- Operator review of the snapshot scope is required before apply (CLI shows what will be snapshot-encrypted; operator confirms with `--write`).

### 7.3 Retention

- **Permanent retention** of any snapshot referenced by an active ledger entry.
- **Permanent retention of the latest-successful snapshot per domain**, regardless of N. Operators always have one known-good recovery point per domain. Pruning never removes this snapshot.
- Beyond the above, retain the last N snapshots per domain (default N=10; configurable per fleet).
- Pruning is operator-gated (`npm run migrate -- --prune-snapshots --domain <name>`).

### 7.4 Rollback

**Snapshot-first by default.** Every applying migration MUST have a snapshot restore path. Custom `rollback()` is the exception, not the norm; it is allowed only when snapshot restore is insufficient (e.g., the migration's apply has irreversible external side effects that snapshot restore alone can't undo) AND the custom rollback is dry-runable, idempotent, and test-covered.

For auto-apply migrations: framework auto-rollbacks on detected post-apply integrity failure (parse error, mismatched `_schemaVersion`, dry-run-vs-apply diff mismatch).

For operator-gated migrations: rollback requires explicit operator command — `npm run migrate -- --rollback <ledger-entry-id>`.

For hard-fail migrations: not applicable (didn't run).

Rollback writes a new ledger entry (a rollback is itself a ledger event). The original entry's `status` becomes `rolled_back` with a reference to the rollback entry's id.

### 7.5 Rollback constraints (deliberate, not bugs)

- Cannot roll back if a later migration on the same domain has been applied — chain rollback would require coordinated reverse-application of intermediate migrations and is **out of v1 scope**. Operator can manually chain-rollback or, preferred, forward-fix.
- Cannot roll back if any cross-domain dependency has advanced — the parent cross-domain migration must be the rollback unit, not a child sub-migration.

These constraints favor **forward-fix over rollback** for complex cases. Snapshots are the safety net, not the everyday recovery tool.

## 8. Cross-domain orchestration

When a single conceptual change spans multiple domains, the framework treats it as one orchestrated migration:

- Parent `migration_id` declares `touches: [<domain1>, <domain2>, ...]`
- Per-domain sub-migrations carry `parent_migration_id` referencing the parent
- **Snapshots taken for ALL touched domains BEFORE any apply** — pre-apply snapshot is atomic across the orchestration
- Apply runs in declared dependency order (cross-domain `dependsOn`)
- If ANY sub-domain fails post-checks, all completed sub-domains roll back via their snapshots; the parent is marked `rolled_back`
- Ledger records the parent + each sub-record; partial-success states are not allowed (atomic across the orchestration boundary)

**Cross-domain migrations are always `operator-gated`.** The framework refuses to auto-apply any migration with `touches.length > 1`, regardless of what the migration declares — this is one of the hard-fail outcomes from §5.3.

## 9. Multi-version upgrade paths

If a user is on schema v(N-3) for some domain and upgrades to a WhatSoup release shipping v(N) for that domain:

1. Framework loads all migrations for the domain
2. Validates a contiguous chain `(N-3) → (N-2) → (N-1) → N` exists with no gaps
3. Applies sequentially — each step takes a snapshot, applies, runs post-checks, writes ledger entry, before the next step runs
4. If any step fails, that step rolls back; the chain stops; framework surfaces the failure position with the ledger snapshot of where state currently is
5. Operator can fix the failing migration and restart the chain — already-applied steps are detected via ledger as `succeeded` and skipped (idempotent at the chain level via the ledger check)

**Bounded backwards compatibility:** WhatSoup v(N) supports auto-migration from any schema version with a contiguous chain to v(N). If the chain is broken (a migration was deleted, was never written, or fails validation), the framework refuses with a clear error pointing at the gap.

**Compatibility-window policy is the deprecation-policy sibling spec's job to define.** This framework provides the mechanics for arbitrary windows; the policy decides how far back is supported.

## 10. Testing discipline

Each migration ships with at least three tests in `tests/migrations/<domain>/<migration_id>.test.ts`:

- **Apply test** — input fixture at `from_version`, run `apply()`, assert output matches expected at `to_version`
- **Idempotence test** — run `apply()` twice, assert second is no-op or converges to identical state
- **Rollback test** — apply, then snapshot-restore (or `rollback()` if custom), assert state matches original input

For operator-gated migrations:

- **Dry-run test** — assert `dryRun()` output is a structured `DryRunReport` matching actual apply outcome (preview matches reality)

For cross-domain migrations:

- **Orchestration test** — all sub-domains apply correctly in dep order; failure injected in any sub-domain triggers correct rollback of all completed sub-domains; parent ledger entry shows `rolled_back`

For migrations that touch credentials:

- **Credential isolation test** — assert the migration doesn't read or write live keychain entries; mocks for `node:child_process` per the existing pattern at `tests/lib/keyring.test.ts:1-12`

Migration tests use real config fixtures; they NEVER touch live `<configRoot>`, live keychains, live `tokens.env`, or live deploy artifacts.

The existing `tests/config-memory-migration.test.ts` is the prototype that all new tests follow.

## 11. Out of scope (sibling specs)

This spec owns: per-domain migration framework, ledger, trigger tiers, migration definition shape, snapshots, rollback, cross-domain orchestration, multi-version chains, testing discipline.

Explicitly NOT covered:

- **Compatibility / deprecation policy** — what schema versions WhatSoup commits to supporting in the wild, how long, how deprecations are announced. Sibling spec needed.
- **Public-release readiness** — install scripts, GitHub release process, version numbering policy, support model. Sibling spec needed.
- **DB schema migrations** — already covered by `src/core/database.ts` and the `schema_migrations` table. This framework cross-references but does not absorb. Cross-domain migrations may declare DB-side dependencies; the DB framework itself stays in its lane.
- **Provider keychain migration mechanics** — covered by `docs/security-handoffs/2026-05-09-env-secret-exposure-kickoff.md`. The `health_tokens` domain in this framework handles the migration of token storage; the broader credential-handling discipline is described there.
- **Protection-policy semantics** — what posture rules mean, how they're authored. Covered by `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`. This framework's `protection_policy` domain handles versioning and migration of the policy artifact; the policy's semantics live in the protection-layer spec.

## Glossary

- **Domain** — a logical grouping of settings with a single source-of-truth artifact and a single canonical-ownership story (or a documented mixed-by-section ownership for `instance_config` and `agent_settings`).
- **Source of truth** — the artifact's embedded `_schemaVersion` (or per-format equivalent). The ledger is audit history, not source of truth.
- **Ledger** — append-only history of applied migrations per domain at `<configRoot>/.migration-ledger/<domain>.jsonl`.
- **Snapshot** — pre-apply byte-copy of affected artifacts; the default rollback path.
- **Migration** — a TypeScript module declaring `from_version → to_version` for a domain, with `apply()`, `dryRun()`, optional `rollback()`.
- **Trigger tier** — author's classification: `auto-apply` (boot-time, non-destructive) or `operator-gated` (requires explicit `--write` flag).
- **Hard-fail** — framework outcome when a migration's metadata or safety properties fail validation. Not an author-chosen tier.
- **Cross-domain migration** — a migration whose `touches` includes more than one domain. Always operator-gated; orchestrated atomically.
- **Forward-fix** — preferred recovery strategy: instead of rolling back a failed migration, fix the migration definition and re-apply forward. Snapshots remain the safety net for cases where forward-fix isn't possible.

## Cross-references

- `docs/specs/2026-05-09-fleet-topology-control-plane-design.md` — fleet topology + per-domain canonical ownership the migration framework relies on.
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` — protection policy whose artifact is one of this framework's domains.
- `docs/security-handoffs/2026-05-09-env-secret-exposure.md` and `2026-05-09-env-secret-exposure-kickoff.md` — credential handling discipline the `health_tokens` domain rides on; the kickoff's seven non-negotiable preservation guarantees are inherited as the framework's credential-handling baseline.
- `src/config-memory-migration.ts` and `tests/config-memory-migration.test.ts` — the prototype migration this framework generalizes.
- `src/core/database.ts` and `schema_migrations` table — DB schema migration framework; out of this spec's scope but cross-domain migrations may reference it.
- `CLAUDE.md` — repo overview, instance model, conventions (ESM, Zod, Pino, vitest --pool=forks).

Sibling specs to be written:

- `docs/specs/<date>-compatibility-deprecation-policy-design.md`
- `docs/specs/<date>-public-release-readiness-design.md`
