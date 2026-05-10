# WhatSoup Public Release Readiness — Design

| | |
|---|---|
| Date | 2026-05-10 |
| Status | Design — pending implementation planning |
| Scope | v1 release-readiness baseline: target audience, license, vendor connectivity, install paths, support model, required boilerplate, README structure, release process, documentation surface. |
| Out of scope | Architecture, migration mechanics, compatibility contract, protection-layer mechanics — already covered by sibling specs. |

## 1. Mission

WhatSoup ships from a single-machine local-tooling shape into a public product. Three sibling specs already define the architecture (fleet topology), the mechanics for evolving config across versions (settings migration framework), and the external compatibility contract (compatibility & deprecation policy). This spec defines the **v1 release-readiness baseline** — the install paths, distribution channels, license, support model, vendor-connectivity posture, required boilerplate, and release process that make WhatSoup actually shippable to operators outside the author's machine.

This is the last of four context docs identified during the 2026-05-09 evolution-direction brainstorm.

## 2. v1 release target

**Self-hosted operator product** for technically capable operators running WhatSoup on their own machines.

**Supported platforms (first-class):** macOS/launchd, Linux/systemd, Docker.

**Supported install paths:**
- Docker (first-class, primary recommendation, easiest portable path)
- Native macOS/launchd (first-class)
- Native Linux/systemd (first-class)
- Source clone + `npm ci` (supported development/operator path; **NOT recommended for production**, lacks upgrade/rollback discipline parity)

**NOT in v1:** hosted SaaS, public TypeScript/plugin developer API, enterprise/LTS contract, vendor telemetry on by default.

**Forward-compatible (architecture leaves room for, but does not promise):** hosted services later, public plugin API later, LTS designation later. None of these are promised in v1; none are blocked from being added in a future release.

## 3. License — Apache 2.0

WhatSoup v1 ships under the Apache 2.0 license.

Reasons:
- Permissive and operator-friendly.
- Explicit patent grant, which matters more as WhatSoup becomes a product.
- Compatible with commercial and self-hosted deployments.
- Lower adoption friction than AGPL or source-available licenses.
- Doesn't block future hosted-service offerings.

**Strategic caveat:** Apache 2.0 does NOT prevent closed SaaS clones. If "prevent closed SaaS clones" becomes a strategic goal later, Apache 2.0 won't do that — would require a different licensing strategy (BSL, Elastic License, dual-licensing), ideally before v1.0.0 to avoid relicensing past contributions.

**License header policy:**
- Root `LICENSE` file with full Apache 2.0 text.
- `package.json` `"license": "Apache-2.0"` field.
- **No required per-file headers for v1.** Source files do not need to carry SPDX-License-Identifier comments.
- Optional SPDX headers are allowed only on files that already need a header for generated/license-sensitive content.

## 4. Vendor connectivity (opt-in only)

**Default install makes zero vendor network calls.** Vendor channels are explicit opt-in, per fleet/admin.

**Constraints:**
- Local nodes remain fully autonomous if vendor services are unavailable.
- Vendor connectivity must NEVER be required for: local runtime, admin/client operation, migrations, recovery.
- Each vendor channel has its own toggle, scope, retention statement, and "what data leaves the machine" description.
- Mirrors the fleet topology spec's admin/client architecture: local node autonomous, vendor is supervisory/service-side only.

**v1 opt-in channels** (each individually toggle-able, each disabled by default):

### 4.1 Update checks

Periodic check against a vendor endpoint for new releases. Default scope is minimized:
- **Default reports only:** `current_version`, `release_channel`.
- **Optional diagnostic metadata** (operator opts in separately): `platform`. Even platform can be identifying in small populations and is not part of the default check.

No instance metadata, no fleet identity, no telemetry beyond version-and-channel.

### 4.2 Diagnostic bundle upload

Operator-initiated upload of a redacted diagnostic bundle for support.

**Required mechanics:**
- Bundle generator includes redaction policy + manifest of what's included.
- **Operator must be able to inspect the redacted archive + manifest BEFORE upload.** The CLI flow surfaces an inspection step; no auto-upload.
- Operator confirms upload after review.

### 4.3 Health/reporting summary

**Local fleet-to-admin only in v1.** Vendor-facing health reporting is a planned-but-not-required opt-in channel for v1.0; deferred until privacy docs and retention policies are mature.

In v1, fleet telemetry stays inside the fleet's trust boundary (admin sees client telemetry per the fleet topology spec).

### 4.4 Hosted-service pairing placeholder

Design hook for hosted-service pairing in a later release. **No implementation in v1.** Documented as a forward-compatible architecture surface; described in the spec but not buildable.

### 4.5 Per-channel documentation

Each opt-in channel has a doc at `docs/vendor-channels/<channel>.md` covering scope, opt-in mechanics, what data leaves the machine, retention period, and disable instructions.

## 5. Install paths

| Path | Status | Notes |
|---|---|---|
| **Docker** | First-class, primary recommendation | Image published to GHCR (recommended target); Compose template provided |
| **Native macOS/launchd** | First-class | Setup script + plist generation; first-class, not experimental |
| **Native Linux/systemd** | First-class | Setup script + unit template generation |
| **Source clone + `npm ci`** | Supported development/operator path | NOT recommended for production; lacks upgrade/rollback discipline of containerized/service-managed installs |

### 5.1 Per first-class path documentation

Each first-class path requires:
- `install-<path>.md` — install instructions
- `upgrade-<path>.md` — upgrade procedure
- `backup-restore-<path>.md` — backup and restore procedure
- `uninstall-<path>.md` — clean uninstall
- `troubleshoot-<path>.md` — common issues and resolution
- `security-<path>.md` — security notes specific to this path (file ownership, port exposure, default permissions)
- `verify-<path>.md` — verification checklist after install/upgrade

### 5.2 Source clone documentation

Source clone has lighter docs but **does include backup/restore**:
- `install-source.md` — clone + `npm ci` + initial config
- `troubleshoot-source.md` — common dev/source-clone issues
- `backup-restore-source.md` — points to the same config/data backup procedure as native installs (the code checkout is user-managed, but WhatSoup state still needs documented backup/restore regardless of install path)

### 5.3 Docker image provenance (readiness target)

Even if not fully implemented in v1.0.0, the release-readiness doc calls out image provenance as a readiness target:
- Image tags follow semver (`:1.0.0`, `:1.0`, `:1`, `:latest`)
- Image digest pinning supported and documented
- Release notes include the image digest for each Docker release
- Image signing / SLSA attestations are a forward-target — not required for v1.0.0, but the architecture should leave room for them

## 6. Support model

**GitHub Issues + GitHub Security Advisories. No SLA. Best-effort response.**

### 6.1 Channels

- **Bugs and feature requests:** GitHub Issues with templates (`bug-report`, `feature-request`).
- **Security disclosure:** GitHub Security Advisories (GHSA) with private vulnerability reporting. Reporters submit via GHSA's private flow; advisories publish only after coordinated fix.

### 6.2 Required content in security reports (specified by SECURITY.md)

- Affected version
- Deployment path (Docker / macOS-launchd / Linux-systemd / source)
- Reproduction steps
- Exposure surface (LAN-only / tailnet / public-facing)
- Whether credentials or message data may be involved

### 6.3 No-secrets-in-public-issues policy

Issues and Discussions are public. Operators **must not** paste:
- Credentials, API keys, bearer tokens
- Message content / personal data
- Private URLs (internal hostnames, FQDN of admin host, fleet identifiers)
- Log excerpts that contain tokens, secrets, or sensitive paths

For sensitive reports, use GHSA's private vulnerability reporting. SECURITY.md, CONTRIBUTING.md, and the bug-report template all include this guidance prominently.

### 6.4 No SLA, no LTS, no enterprise support

Documented in SECURITY.md, CONTRIBUTING.md, and the README's "Support" section. Aligns with the compat-policy spec's anti-overclaim guard.

## 7. Required boilerplate (v1.0.0 release blockers)

The repo currently lacks several files expected for a public-shipping product. v1.0.0 release is blocked until these land **as committed files**:

- `LICENSE` — full Apache 2.0 text
- `SECURITY.md` — security disclosure process per §6, GHSA private reporting, required-content checklist, no-secrets-in-public-issues policy
- `CONTRIBUTING.md` — PR process, no-SLA framing, required test coverage for public-surface changes, conventional-commits guidance, hygiene-guard expectations, no-secrets-in-public-issues policy reiteration
- `CHANGELOG.md` — initial entry for v1.0.0; subsequent entries follow the compat/deprecation spec's six mandatory labels with the parseable boolean metadata block (Operator action required is a top-level boolean PLUS a section; Public surface additions is included)
- `.github/ISSUE_TEMPLATE/bug-report.yml`
- `.github/ISSUE_TEMPLATE/feature-request.yml`
- README updates: license badge, support pointer, install-path index, link to CHANGELOG, link to docs/

### 7.1 Release-checklist items (verified manually, not file-blocking)

These are not files in the repo and cannot be CI-verified; they are checked off manually before v1.0.0 is tagged:

- GitHub Security Advisories private reporting **enabled** in repo settings
- Branch protection on `main` configured per maintainer preference
- GHCR image build pipeline configured
- Repo description and topics set on GitHub
- README rendering verified on GitHub mobile view

The release-readiness checklist lives at `docs/release-checklist-v1.0.0.md` and gets a green-tick per item before tagging.

### 7.2 Already present

Verified by repo inspection at brainstorm time:
- README has host deployment, Docker quick start, dependency notes, API overview
- `docs/releases/` directory exists
- `npm run verify:release` script exists
- `package.json` exists (needs `"license": "Apache-2.0"` field added)

## 8. README structure (v1)

Top-of-file order:

1. Project name + one-line description
2. License badge + supported-platforms badges
3. Quick start (Docker first, then native by-platform)
4. Documentation index (links to `docs/`)
5. Support pointer (issues + GHSA + no-secrets-in-public reminder)
6. License attribution

**Removed / de-emphasized for v1:**
- Marketing claims (enterprise, LTS, plugin ecosystem) — explicitly excluded per §2 v1 target and §3 strategic caveats
- Internal architecture deep-dive — moves to `docs/architecture.md` if needed; README stays focused on operator-relevant info

### 8.1 Machine-parseable metadata

Top-of-file metadata block (YAML in HTML comment or front-matter):

```yaml
release_track: v1-readiness
supported_platforms: [docker, macos-launchd, linux-systemd]
license: Apache-2.0
```

**Do NOT hardcode the version number** in README metadata. Static version metadata drifts as releases ship. Either:
- Use `release_track` as a stable label (above), OR
- Omit version metadata entirely until release tooling can populate it

The version is the source of truth in `package.json` and the latest CHANGELOG entry; README references those rather than asserting its own.

## 9. Release process

Releases follow the compat/deprecation spec's six-label structure.

### 9.1 Per-release procedure

1. Maintainer manually bumps version per semver rules (§3 of compat/deprecation spec).
2. CHANGELOG.md entry added with all six mandatory labels:
   - Breaking changes
   - Migrations
   - Deprecations
   - Public surface additions
   - Security fixes
   - Operator action required (top-level parseable boolean PLUS section explaining what action, if any)
3. Release artifacts:
   - GitHub Release with the CHANGELOG entry as release notes
   - Docker image tagged + pushed to GHCR; **release notes include the image digest**
   - npm package publication is **deferred** for v1 — decision in a future release-readiness milestone
4. Verification:
   - Existing `npm run verify:release` script passes
   - Per-install-path verification checklists from §5.1 each pass for at least one supported platform
   - Release-checklist items from §7.1 each green-ticked

### 9.2 Cadence

Rolling-release. **No committed cadence; no calendar-based promises.** Minor releases when additive capability lands; patch releases as fixes accumulate; majors only when a breaking change is required AND the migration framework can support the schema bump.

## 10. Documentation surface

**v1 ships in-repo `docs/` only.** A separate documentation site (e.g., docs.whatsoup.example) is NOT a v1 deliverable.

- Documentation lives at `docs/` in the repo. GitHub renders Markdown natively; that's the v1 "site."
- Per-install-path docs at `docs/install/<path>/*.md` (per §5.1 requirements).
- Vendor-channel docs at `docs/vendor-channels/<channel>.md` (per §4.5).
- Release-checklist + release-process docs at `docs/release-checklist-v1.0.0.md` and `docs/release-process.md`.

Future evolution may include a generated docs site (Docusaurus / mkdocs / Astro Starlight); deferred to a later release.

## 11. Out of scope (already-done siblings + post-v1 items)

This spec owns: v1 release target, license, vendor connectivity, install paths, support model, required boilerplate, README structure, release process, documentation surface.

**Already-shipped sibling specs (cross-referenced, not duplicated):**

- `docs/specs/2026-05-09-fleet-topology-control-plane-design.md` — fleet topology + admin/client model
- `docs/specs/2026-05-09-settings-migration-framework-design.md` — per-domain migration framework
- `docs/specs/2026-05-10-compatibility-deprecation-policy-design.md` — external compatibility contract
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` — declared-posture verification

**Post-v1 evolution (intentionally not designed here, but architecture leaves room):**

- Public TypeScript / plugin developer API
- LTS designation (revisited at v2.0 per compat/deprecation spec)
- Hosted service offering (room left in vendor-connectivity architecture per §4)
- Generated documentation site
- Automated CHANGELOG generation from PRs
- npm package publication
- Image signing / SLSA attestations (forward target per §5.3)
- Release-checklist issue template

## Glossary

- **First-class install path** — supported with a complete documentation set (install, upgrade, backup-restore, uninstall, troubleshoot, security, verify).
- **Supported development/operator path** — supported but not recommended for production; lighter doc set; lacks the upgrade/rollback discipline parity of first-class paths.
- **Vendor channel** — an opt-in network channel from a WhatSoup deployment to vendor infrastructure, scoped to a single function (update check, diagnostic upload, etc.).
- **GHSA** — GitHub Security Advisories; the private security disclosure flow.
- **Release-readiness blocker** — an artifact that must be present in the repo (or a manual checklist item that must be green-ticked) before v1.0.0 can be tagged.
- **Release track** — `v1-readiness`, used as a stable metadata label in README in place of a hardcoded version number.

## Cross-references

- `docs/specs/2026-05-09-fleet-topology-control-plane-design.md` — fleet topology defines admin/client/standalone modes
- `docs/specs/2026-05-09-settings-migration-framework-design.md` — migration framework whose tiers govern auto-migration semantics
- `docs/specs/2026-05-10-compatibility-deprecation-policy-design.md` — external compatibility contract; this spec inherits the six-label release-notes structure and the public-surface registry
- `docs/specs/2026-05-08-whatsoup-protection-layer-design.md` — protection-layer policy; this spec doesn't override its semantics
- `package.json` — needs `"license": "Apache-2.0"` field
- `scripts/repo-hygiene-guard.ts` — ensures public-repo hygiene; existing
- `scripts/pre-push-guard.ts` — pre-push verification; existing
- `npm run verify:release` — existing release-verification script
