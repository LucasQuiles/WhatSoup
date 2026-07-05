# Onboarding safety + first-run fixes — design

Status: approved-for-planning · Owner-picked cluster from the 2026-07-05
onboarding gap walk (lane record: `~/.claude/plans/onboarding-gap-walk/STATUS.md`;
walk pinned at `76c5c33d`, re-validated at `60c91901` — the only intervening
change to a cited file is the SMS rate-limit row in `docs/configuration.md`,
untouched sections re-anchored: Custom endpoint :716, fallback key provisioning
:822).

## Verified findings this design fixes

1. **Wizard API keys persist as inert plaintext (HIGH).** The Add Line wizard's
   Model step collects `apiKey`/`openaiKey` as top-level wizard-state fields
   (`console/src/components/wizard/ModelAuthStep.tsx:231-232`). The Review-step
   finish sends the entire form state to `PATCH /api/lines/:name/config`
   (`AddLineWizard.tsx:250`; `console/src/lib/api.ts:394` does no filtering),
   where `deepMergeRecords` (`src/fleet/routes/ops.ts:54-65`) merges arbitrary
   top-level keys — only `settingsJson` is stripped (`ops.ts:555`) — and
   `validateInstanceConfig` has no closed schema, so the raw key lands in
   `~/.config/whatsoup/instances/<name>/config.json` with a 200 and no warning.
   Nothing ever reads it: every auth path resolves via
   `resolveApiKey({service, envVar})` (`anthropic-api.ts:128`,
   `openai-api.ts:124`), and the resolver's `inline` precedence slot
   (`api-key-resolver.ts:22`, "reserved for future config") has zero callers.
   Net: the key leaks at rest AND never authenticates anything, violating the
   documented write-only keyring model (`README.md:339-343`). The console never
   calls `PUT /api/credentials/:service` anywhere.
2. **Quick Start dead-ends at the console lock screen.** README Quick Start
   says "Open http://localhost:9099" but never mentions the lock screen; the
   fleet token is auto-written to `~/.config/whatsoup/fleet-tokens.json`
   (`src/fleet/token-storage.ts:216`) and the standalone server logs only an
   8-char prefix (`src/fleet/standalone.ts:19`). The retrieval path is
   documented only in `docs/console-guide.md:5-22`, which Quick Start does not
   link.
3. **BYOK-as-primary is undocumented and its docs are cross-link-orphaned.**
   The wizard genuinely exposes provider + `providerConfig.baseUrl`/
   `apiKeyService` at creation (`ConfigStep.tsx:486-534`,
   `console/src/lib/providers.ts:89-90`) — mentioned in no doc;
   `docs/configuration.md` frames Groq/OpenRouter exclusively as fallback
   rungs; key provisioning lives only under "Enabling provider fallback on a
   new host" (:822); the two key-storage paths (keychain CLI vs
   `PUT /api/credentials`) and the two verify paths (`FALLBACK ON` canary vs
   `POST .../verify`) never cross-reference each other.

## Owner decisions on record

- Cluster: Safety + first-run (Gaps 1-3 above). Deferred gaps registered as
  QR-234..QR-237 (see Out of scope).
- Gap 1 approach: **B — wire + strip** (not strip-only, not inline-key).
- Gap 2: docs paragraph **plus** startup log line printing the token file
  path (path only — never the token value).

## Component 1 — wizard credential wiring + server strip

Console (`AddLineWizard` finish path):
- Remove `apiKey`/`openaiKey` from the config PATCH payload entirely (project
  the wizard state before `api.updateConfig`, or stop storing keys in the
  shared form-state bag).
- New `api.setCredential(service, key)` → `PUT /api/credentials/:service`
  (existing keyring-backed route) called from the finish flow when a key was
  entered.
- **Write-allowlist constraint (verified):** the credentials route has its own
  compile-time closed set `CREDENTIAL_ALLOWLIST` = {deepseek, minimax, openai,
  anthropic} (`credentials.ts:30-36`); an unknown-but-SERVICE_ENV_MAP-valid
  service (groq, openrouter, …) returns **404** today. The route's docstring
  promises operators can extend it via fleet config `extraCredentialServices`,
  but `setExtraCredentialServices` has only test callers — that path is
  unwired (registered as QR-238). Therefore the wizard auto-stores ONLY when
  the target service is in the effective allowlist; for any other service it
  shows the keychain-CLI instructions toast instead, and the docs state
  plainly that custom services require CLI/keychain provisioning today.
  Extending the write contract is deliberately NOT in this cluster (the
  closed set is a designed security posture; changing it deserves its own
  review).
- **Key-to-service routing rule (explicit helper + test matrix, no
  cross-vendor writes):** the wizard collects up to two keys, and an explicit
  `apiKeyService` must never receive the wrong vendor's key. Anthropic-key →
  explicit service ONLY when the configured provider path is `anthropic-api`,
  else default `anthropic`. OpenAI-key → explicit service ONLY when the
  provider path is the OpenAI-compatible one (`openai-api`, or opencode's
  openai-prefixed model), else default `openai`. The helper is pure and
  unit-tested against the full matrix (both keys × explicit/absent service ×
  provider paths), locking that a Groq/OpenRouter `apiKeyService` never
  receives an Anthropic key.
- On success, optionally call the existing `POST /api/credentials/:service/verify`
  and render the one-probe verdict inline (nice-to-have; drop if it bloats the
  PR).
- On failure, non-blocking notification via the app-wide `useToast().error(...)`
  primitive (`console/src/hooks/use-toast.tsx`, wired at `main.tsx:24`) — NOT
  the wizard's modal-scoped `createError` and NOT `AlertBanner` (fleet-health
  semantics); do not invent a fourth notification pattern. Message carries the
  keychain-CLI fallback command; the line is still created — honestly keyless —
  and the wizard says so. Failure modes are real-world only: 404 unknown
  credential service (not in the write allowlist), 403 blocklisted service
  (e.g. the health token), network failure, keyring-locked 503.
- Auth: RESOLVED as fact (verified at `60c91901`) — `PUT /api/credentials/:service`
  is a plain api-audience route (`audienceForPath`, `src/fleet/index.ts:785-789`
  special-cases only the SSE auth path), and the console's `apiFetch()` already
  auto-mints an api-audience ticket accepted via the console-session cookie
  (`index.ts:900-921`). `api.setCredential` is therefore a two-line `apiFetch`
  addition with zero new auth plumbing.

Server (defense in depth):
- `handleConfigUpdate`: strip top-level `apiKey`/`openaiKey` by extending the
  existing `settingsJson` destructure at `ops.ts:554-556` — same idiom, same
  line.
- `handleCreateLine`: regression guard only, NOT an active hole — CREATE's
  `PASSTHROUGH_FIELDS` allowlist (`ops.ts:1052-1059`) already excludes the key
  fields; the guard exists so a future allowlist growth can't reopen the leak.
  The live vulnerability is exclusively the PATCH deep-merge path.
- **Remediation for existing victims — exact mutation points (verified):**
  cleanup runs ONLY where config is already written back — the PATCH path
  (`handleConfigUpdate`, alongside `migrateLegacyMemoryConfig` at
  `ops.ts:556`) and the CREATE path (`ops.ts:1063`). The config LOAD path
  (`config.ts:694`) migrates in memory and does NOT write back; this spec
  adds no loader writeback and no startup sweep (a new writer under the
  private-config lock is out of proportion here). Honest statement: existing
  at-rest keys are removed on the NEXT CONFIG WRITE only; until an instance's
  config is next written, the stray field remains on disk. The advisory
  therefore covers both rotation and optional manual removal. Implemented as
  a NEW sibling migration with the same `{config, changed, removed}` result
  shape as `migrateLegacyMemoryConfig`, not a literal extension of that
  module (it is a field-rename engine; this is a plain drop). Verified safe:
  nothing in `src/` or `console/src` reads the raw config-file key fields.
  The rotate-your-key advisory sentence ships IN PR 1's diff (not deferred to
  the docs PR) so the silent deletion never lands without its documented
  advisory.

## Component 2 — Quick Start unblock

- README Quick Start, after the "Open http://localhost:9099" step: one
  paragraph — the console starts locked; the token is auto-generated on first
  run at `~/.config/whatsoup/fleet-tokens.json`; link to console-guide's
  authentication section.
- `src/fleet/standalone.ts`: log the token **file path** alongside the
  existing prefix line. Never the token value.

## Component 3 — BYOK-primary docs stitching

All in `docs/configuration.md` + `docs/console-guide.md`; no retitling of
sections the doc-sync guard anchors on (`tests/lib/provider-service-doc-sync.test.ts`
parses the env-var table header and probe-list sentences — additions only).

- New "Custom endpoint as primary provider" subsection under Custom endpoint
  (:716): worked Groq-as-primary `config.json` example (`provider:
  "openai-api"` + `providerConfig` + required fallback-model note), plus a
  sentence that the Add Line wizard exposes the same fields at creation.
- Cross-links: custom-endpoint ↔ key-provisioning routes (:822) both
  directions; keychain CLI ↔ `PUT /api/credentials` as peer alternatives;
  `FALLBACK ON` canary ↔ `POST .../verify` as peer verification paths.
- `docs/console-guide.md` wizard section: document the Config-step provider
  selector (agent type only) with Base URL/Keyring Service fields, and the
  post-fix Model-step behavior (keys go to the OS keyring via the credentials
  API; never into config.json).

## Testing

- Server strip: PATCH carrying `apiKey`/`openaiKey` → 200, fields absent from
  the written file; control asserts a legitimate sibling field survives the
  same merge. Migration cleanup: config with stray key fields loads → fields
  removed on next write, warning logged.
- Console: payload-projection unit test if console test infra permits (check
  at plan time); otherwise assert via the wire-shape the finish path builds.
- Docs: `guard:doc-drift`, doc-sync guard, and `guard:publication` green;
  README/console-guide changes are publication-visible surfaces.
- Full curated push gate + touched-suite runs per repo discipline (CLAUDE.md:
  local gate is a subset of CI; run touched tests directly).

## Rollout

Three small PRs, in order, each independently green: (1) server strip +
migration + tests + the rotate-key advisory sentence (closes the security
hole regardless of console pace; PR 1 alone creates no UX regression — the
key never authenticated anything, so persisted-dead-plaintext →
silently-stripped is user-observably identical until PR 2's honest UI);
(2) console wizard wiring + honest UI; (3) docs (Components 2 + 3 can share
this PR). Branch-per-PR off current main; normal gate cycle; merge order
matters only in that PR 2's UI copy assumes PR 1's strip exists.

## Out of scope (registered, not lost)

- QR-234: post-creation provider/`providerConfig` immutable in console
  (DOM-level read-only JSON blob; only legacy fallback pair editable — the
  modern `fallbacks[]` chain isn't editable either).
- QR-235: crit-severity alerts hardcode generic "configuration error" while
  the specific text already arrives in the list route's `error` field
  (rendered for warn severity; `FeedCard.tsx:420-424`). Related: QR-220.
- QR-236: `endpointHost`/`apiKeyService` arrive at the console untyped and
  unrendered (`console/src/types.ts:268-273`; render-only fix). Related:
  QR-233.
- QR-237: wizard type labels (Passive/Chat/Agent) never map to the canonical
  four-instance model; Session Scope silently defaults to sandbox
  (`AddLineWizard.tsx:86`).
- QR-238: credential write allowlist (deepseek/minimax/openai/anthropic) is a
  strict subset of SERVICE_ENV_MAP, and the documented fleet-config extension
  path (`extraCredentialServices` → `setExtraCredentialServices`) has no
  production caller — custom services (groq/openrouter) cannot be provisioned
  via the API at all; doc-vs-code drift in the route's own docstring.
