# WhatSoup Process-Environment Secret Exposure

**Owner:** WhatSoup application/runtime
**Discovered:** 2026-05-09 during deployment hardening
**Status:** implementation-complete; live rollout pending
**Severity:** medium-high

This is a WhatSoup application/runtime issue, not a general host-hardening task. Host, network, and unrelated service posture should stay in their own deployment trackers.

## 2026-07-21 implementation receipt

The terminal implementation is complete on a controlled alignment branch, pending
the controlled live rollout and post-reboot proof. Managed launchers remove all
protected provider and health-token names from the parent; CLI child environments
exclude those names; OpenAI chat/Whisper resolve the canonical keyring service at
use time; health mutation auth resolves only the instance-scoped keyring entry;
and systemd no longer projects `secrets.env` or `tokens.env` into the parent.
`tokens.env` remains unchanged because fleet discovery still requires it.

Deployment acceptance remains open until the manifested release is active and a
GUI-domain verifier proves: connected primary instance, usable model evidence,
the deployment-owned recovery-record invariant, preserved owner-blocked secondary
state, and no protected
secret names in applicable parent/child environments. No recovery replay, closure,
or WhatsApp pairing is part of this rollout.

## Phase Status

Phase letters map to the W-1..W-6 wave nomenclature used in the kickoff doc's Coordination touchpoints (`2026-05-09-env-secret-exposure-kickoff.md:266`). Each row tracks accepted merged work for that phase; phases that intentionally ship across multiple PRs list each accepted partial PR/SHA and the remaining pending scope. `pending` rows have no merged work yet.

| Phase | Title | Status | Accepted provider/phase work (PR/SHA/date) | Pending provider/scope |
|---|---|---|---|---|
| W-1 / Phase A | Extend `keyring.ts` with a typed lookup API (no behavior change) | complete | Typed lookup and closed-id gate are present on current `origin/main` | — |
| W-2 / Phase B | Provider boundary migration | complete | All protected provider read sites pass the static secret-env guard; OpenAI chat and Whisper now infer the canonical keyring service when no override is configured | — |
| W-3 / Phase C | Reverse the precedence (resolver-first, env-fallback) | complete | `resolveApiKey` supports explicit fallback policy and canonical service inference | — |
| W-4 / Phase D | Stop child env inheritance | complete | CLI child environments exclude protected provider keys | Live environment proof pending |
| W-5 / Phase E | Health token migration | implementation-complete | Runtime auth uses instance-scoped keyring only; `tokens.env` retained for fleet discovery | Live GUI-domain proof pending |
| W-6 / Phase F | Wrapper-chain removal (deploy cleanup, terminal phase) | implementation-complete | Launcher and systemd parent environments no longer load protected secrets | Controlled live rollout pending |

Phase B notes: PR #370 routed OpenAI and Anthropic API providers through `lookupCredential(apiKeyService)` with env fallback preserved. ElevenLabs is ALSO already migrated: `src/runtimes/chat/providers/elevenlabs.ts:20` resolves its key via `lookupCredential('elevenlabs')` (env-first with keyring fallback), landed in SHA `ef20d66d` on 2026-04-06 — before this handoff was written — so its prior `pending` listing was a documentation staleness error, corrected in the 2026-07-01 re-grounding below. Whisper was migrated to `resolveApiKey()` by PR #1683 (SHA `6ad7606d`, 2026-07-07), corrected in the 2026-07-14 re-grounding below. Pinecone + Knowledge MCP were migrated together by PR #1800 (merged 2026-07-14), preserving the configurable `apiKeyEnv` and Knowledge MCP's fail-open `return null`. Health auth was migrated by PR #1804 (merged 2026-07-14). Pattern B reason-code taxonomy landed in PR #1803 (merged 2026-07-14). **Phase B is now 7 of 7 providers migrated or in-flight** — only model-advisor remains (PR #1801 open).

The remaining Phase B provider, re-verified against `origin/main` (SHA `b6c088a5`) on 2026-07-14:
- Model advisor — `src/lib/model-advisor.ts:134,143` reads `process.env.ANTHROPIC_API_KEY` / `process.env.OPENAI_API_KEY` directly for live model-currency scans. Migration in flight: [#1801](https://github.com/LucasQuiles/WhatSoup/pull/1801).

Phase A (the formal `lookupCredentialTyped` typed API) is in flight: [#1802](https://github.com/LucasQuiles/WhatSoup/pull/1802) adds the typed API with a closed-id gate.

### 2026-07-01 re-grounding (issue #1431)

This handoff was re-verified against `origin/main` at SHA `c40e2992`. Correction: ElevenLabs was wrongly listed as a pending Phase B provider; it has been resolver-routed since 2026-04-06 (`ef20d66d`). The Phase B table and pending list above now reflect actual source state. Phase B remains IN-PROGRESS: 3 of 7 providers migrated (OpenAI, Anthropic, ElevenLabs), 4 still OPEN (Whisper, Pinecone, Knowledge MCP, health auth). No migration code was changed by this re-grounding — the remaining migrations are separate owner-gated security work. The handoff stays OPEN.

### 2026-07-14 re-grounding

This handoff was re-verified against `origin/main` at SHA `9353d3c3` as part of a security review of secret-handling patterns. Three corrections:

1. **Whisper is migrated (D-2).** PR #1683 (SHA `6ad7606d`, 2026-07-07) routed the Whisper transcription provider through `resolveApiKey()` at `src/runtimes/chat/providers/transcription/openai-whisper.ts:9,24-29`. The 2026-07-01 re-grounding was against SHA `c40e2992` (pre-#1683); the migration landed five days later. **Phase B is now 4 of 7 migrated**, not 3 of 7. Remaining OPEN: Pinecone, Knowledge MCP, health auth.

2. **Model advisor is an unlisted env-read site (D-1).** `src/lib/model-advisor.ts:134,143` reads `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` directly from env for live `/v1/models` currency scans. This site was not in the Phase B pending list. Severity is low (keys are used in-process for outbound HTTPS, never logged — there is a `redactKey()` helper at `model-advisor.ts:125-129`, and the result is fail-open: missing key → static catalog only). It is added to the Phase B pending list above. Migration shape: route through `resolveApiKey({ envVar: 'ANTHROPIC_API_KEY' })` / `resolveApiKey({ envVar: 'OPENAI_API_KEY' })` (env-only, no service name, since model-advisor has no provider-config surface).

3. **`secrets.env` is a second credential EnvironmentFile not covered by Phase E (D-3).** `deploy/whatsoup@.service:11` loads `EnvironmentFile=-%h/.config/whatsoup/secrets.env` (root-level, shared across instances) in addition to the per-instance `tokens.env` that Phase E targets. WhatSoup's own audit tooling classifies `secrets.env` in `ROOT_CREDENTIAL_FILES` (`scripts/bot-errors-critical-surface-audit.ts:1050`, `deploy/scripts/bot-errors-health-check.py:63`), and `src/core/outbound-message-safety.ts:244` redacts it as a credential path. Based on its placement (loaded alongside the wrapper's provider-key exports), it most likely holds the provider API keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`PINECONE_API_KEY`) that `deploy/whatsoup:130-169` re-exports into the Node process env for chat instances. Exact runtime contents not verified (runtime file, not in repo). **Phase E scope must be expanded or a sibling phase added** to migrate `secrets.env` contents to keyring alongside `tokens.env`.

**Pinecone + Knowledge MCP migration coupling note.** Both providers read `process.env[<configured>]` via the same `config.memory.pinecone.apiKeyEnv` (configurable, defaults to `PINECONE_API_KEY`). They must migrate together; the resolver call must pass the configured envVar, not a hardcoded constant, or operators with custom `apiKeyEnv` break silently. Knowledge MCP's `createPineconeWatchSearch` fail-opens (`return null` on missing key at `knowledge.ts:183-186`) — the migration must preserve this, not convert to a hard error.

No migration code was changed by this re-grounding. The handoff stays OPEN.

### 2026-07-14 re-grounding round 2 (W-2 completion + W-3/W-4/W-5/W-6 in-flight)

This handoff was re-verified against `origin/main` (SHA `b6c088a5`) after a burst of migration work. The phase table above is updated to reflect merged and in-flight PRs:

**Phase B (W-2) is effectively complete.** Six of seven providers have merged resolver migrations: OpenAI (#370), Anthropic (#370), ElevenLabs (`ef20d66d`), Whisper (#1683), Pinecone + Knowledge MCP (#1800, coupled migration preserving configurable `apiKeyEnv` and Knowledge MCP's fail-open), and health auth (#1804). The seventh, model-advisor, is in flight (#1801). Pattern B (reason-code taxonomy) merged in #1803. **Phase B is 7/7 migrated or in-flight.**

**Phase C (W-3) is in flight.** PR #1807 adds the `allowEnvFallback` flag to `resolveApiKey()`. Default `true` (backward-compatible); `false` enables strict keyring-only mode. The audit's recommendation that the policy "name when env-fallback is permitted (dev/test call sites only)" is addressed by the flag: production callers can opt into `false` once keyring coverage is verified.

**Phase D (W-4) is in flight.** PR #1808 routes the four flagged `buildChildEnv` direct reads (`session.ts:188,191,199,200`) through `resolveApiKey()`. The W-2 static guard (PR #1805) has line-level allowlist entries for these; when #1808 merges, those entries must be removed (the stale-entry detector enforces this).

**Phase E (W-5) is partially merged.** PR #1804 (health auth through `lookupCredential`) is merged. The launcher now preserves a preloaded value, reads canonical per-instance `tokens.env` through a bounded no-follow descriptor, then falls back to the scoped Keychain entry and the legacy shared entry. Older launchd plists that duplicate the token in `EnvironmentVariables` should remove that plaintext duplication only after controlled deployment of this wrapper. Keep `tokens.env` until fleet discovery migrates to the same scoped source.

The two private-file paths have different scopes. Unscoped resolver mirrors live
at `$XDG_CONFIG_HOME/whatsoup/credentials/<service>.key`; an account-scoped
lookup never uses them. The health token file lives at
`$XDG_CONFIG_HOME/whatsoup/instances/<instance>/tokens.env` and is explicitly
per-instance. A stale unscoped `.key` file must be audited separately and cannot
satisfy a scoped health-token lookup.

**Phase F (W-6) is scoped.** D-3 (the `secrets.env` scope gap) is resolved: `secrets.env` folds into W-6, not W-5. PR #1806 adds `deploy/check-keyring-presence.sh` (pre-flight tooling) and migration notes on the `EnvironmentFile` line. The wrapper chain removal itself is terminal-phase work that depends on W-3 landing first.

**Verification criterion.** PR #1805 implements the handoff's Verification § static guard: a filesystem-scanning fitness test that fails on direct reads of the five protected secret env vars outside resolver/test/dev allowlists. Negative-verified (adding a direct read correctly fails the guard).

**Pattern adoption status.** Pattern A (closed-target-registry) is in flight via #1802 (baked into the typed `lookupCredentialTyped` API). Pattern B (reason-code taxonomy) merged in #1803. Patterns C (per-attempt resolution) and D (Crestodian) remain DEFER — out of scope for W-1..W-6.

No migration code was changed by this re-grounding. The handoff stays OPEN.

## Finding

WhatSoup secrets can be exposed through process environments on a macOS runtime host.

The live launchd plists do not place `OPENAI_API_KEY`, `PINECONE_API_KEY`, or `WHATSOUP_HEALTH_TOKEN` directly in their `EnvironmentVariables` dictionaries. The exposure comes from wrapper chains that read secrets from keychain, export them, and `exec` Node:

`with-pinecone-env -> with-openai-env -> with-health-token -> node ... bootstrap.ts`

That leaves the parent WhatSoup Node processes visible to same-user process inspection. WhatSoup also intentionally passes `OPENAI_API_KEY` to many child agent processes through `buildChildEnv()`.

Concrete attacker model: a malicious or compromised process already running as the same macOS user can read sibling process env/argv with `ps eww`. This is a local same-user lateral-exposure issue, not a public internet or LAN exposure.

## Affected Runtime Objects

| Object | Current behavior |
|---|---|
| Per-instance launchd plists | Start wrapper chain before Node. |
| `with-pinecone-env` | Exports `PINECONE_API_KEY`, then execs child. |
| `with-openai-env` | Exports `OPENAI_API_KEY`, then execs child. |
| `with-health-token` | Exports `WHATSOUP_HEALTH_TOKEN`, then execs child. |
| `bootstrap.ts <instance>` | Parent processes expose all three named secrets through env. |
| Agent child processes | Many inherit `OPENAI_API_KEY` through `buildChildEnv()`. |

## Repo Evidence

Start the bead with these files:

- `src/lib/keyring.ts` - env-first credential lookup and missing deployment keychain path/account support.
- `src/core/health.ts` - reads `process.env.WHATSOUP_HEALTH_TOKEN`.
- `src/runtimes/chat/providers/transcription/openai-whisper.ts` - reads OpenAI credentials from env.
- `src/runtimes/agent/providers/openai-api.ts` - reads and forwards OpenAI credentials.
- `src/runtimes/agent/providers/anthropic-api.ts` - reads Anthropic credentials.
- `src/runtimes/agent/session.ts` - builds child env and passes OpenAI credentials to CLI-provider children.
- `src/runtimes/chat/providers/pinecone.ts` and `src/mcp/tools/knowledge.ts` - read Pinecone credential env names.
- `src/fleet/routes/ops.ts` - copies a health token from keyring into `tokens.env`.
- `deploy/whatsoup` - can export chat API keys and health token into the Node process env.
- `deploy/whatsoup@.service` - loads `tokens.env` for systemd deployments.

## Desired Fix Shape

1. Add a typed credential resolver.
   - Prefer a keyring-only API such as `lookupCredential({ service, account?, keychainPath?, allowEnvFallback?: false })`.
   - Env fallback should be explicit and restricted to development/test call sites.

2. Support portable credential backends.
   - macOS: `security find-generic-password -s <service> -a <account> -w [keychainPath]`.
   - macOS deployments: support non-secret config for a dedicated secrets keychain path.
   - Linux: `secret-tool lookup service <service> account <account>`.

3. Move secret reads to provider/auth boundaries.
   - OpenAI, Anthropic, Whisper, Pinecone, Knowledge MCP, ElevenLabs, and health auth should resolve secrets through the resolver.
   - The parent WhatSoup process should not need API keys in its environment.

4. Stop child secret inheritance.
   - `buildChildEnv()` must not include API keys for Claude, Codex, OpenCode, Gemini, or other child agent processes.
   - CLI providers should use their native auth or be rejected for env-key-only modes.

5. Remove health-token environment duplication in stages.
   - Keep the canonical per-instance `tokens.env` file private and descriptor-read while fleet discovery remains file-backed.
   - Mirror per-instance health tokens as scoped entries: macOS uses `service=whatsoup-health-token`, `account=<instance>`; Linux uses `service=whatsoup-health-token`, `user=<instance>`.
   - After the descriptor-safe wrapper is deployed, remove plaintext `WHATSOUP_HEALTH_TOKEN` entries from launchd; do not remove `tokens.env` until fleet discovery migrates.

6. Remove wrapper-chain deployment.
   - launchd should run the normal WhatSoup command directly with non-secret `HOME` and `PATH`.
   - Remove `with-pinecone-env`, `with-openai-env`, and `with-health-token` from active ProgramArguments after the app resolves secrets itself.
   - Remove systemd `EnvironmentFile=.../tokens.env` after health tokens move to keyring.

## Verification

- Unit tests cover macOS keychain service/account/path lookup.
- Unit tests cover Linux `secret-tool` lookup with service and account.
- Unit tests prove env fallback is disabled by default and only works with an explicit allow flag.
- Unit tests prove `buildChildEnv()` excludes known secret names even when parent `process.env` contains them.
- Provider tests for OpenAI, Anthropic, Whisper, Pinecone, Knowledge MCP, ElevenLabs, and health auth pass with mocked resolver and empty secret env.
- Fleet tests prove instance creation stores health tokens through the resolver and does not write `tokens.env`.
- Static guard fails on direct reads of `process.env.OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PINECONE_API_KEY`, `ELEVENLABS_API_KEY`, or `WHATSOUP_HEALTH_TOKEN` outside resolver/test/dev allowlists.
- Deployment tests prove generated launchd plists and systemd units contain no secret env files and no secret-injecting wrapper chain.
- Live deployment verification: `ps eww` over WhatSoup parent and child PIDs returns no target secret env names.

## Boundaries

This note should not absorb:

- Host posture, network posture, unrelated service gates, or reboot-survival work.
- Secret rotation work outside the WhatSoup resolver and deployment migration.
- GitHub issue filing or external reporting. Those require explicit approval.
