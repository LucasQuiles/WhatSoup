# WhatSoup Process-Environment Secret Exposure

**Owner:** WhatSoup application/runtime
**Discovered:** 2026-05-09 during deployment hardening
**Status:** in-progress
**Severity:** medium-high

This is a WhatSoup application/runtime issue, not a general host-hardening task. Host, network, and unrelated service posture should stay in their own deployment trackers.

## Phase Status

Phase letters map to the W-1..W-6 wave nomenclature used in the kickoff doc's Coordination touchpoints (`2026-05-09-env-secret-exposure-kickoff.md:266`). Each row tracks accepted merged work for that phase; phases that intentionally ship across multiple PRs list each accepted partial PR/SHA and the remaining pending scope. `pending` rows have no merged work yet.

| Phase | Title | Status | Accepted provider/phase work (PR/SHA/date) | Pending provider/scope |
|---|---|---|---|---|
| W-1 / Phase A | Extend `keyring.ts` with a typed lookup API (no behavior change) | pending | — | Full phase pending |
| W-2 / Phase B | Provider boundary migration (one provider per PR) | in-progress | OpenAI API + Anthropic API providers: [#370](https://github.com/LucasQuiles/WhatSoup/pull/370), SHA `a4bcb536`, merged 2026-05-12. ElevenLabs provider: routed through `lookupCredential('elevenlabs')` in `src/runtimes/chat/providers/elevenlabs.ts:20`, SHA `ef20d66d`, merged 2026-04-06 (predates this handoff) | Whisper, Pinecone, Knowledge MCP, health auth |
| W-3 / Phase C | Reverse the precedence (resolver-first, env-fallback) | pending | — | Full phase pending |
| W-4 / Phase D | Stop child env inheritance | pending | — | Full phase pending |
| W-5 / Phase E | Health token migration (move off `tokens.env`) | pending | — | Full phase pending |
| W-6 / Phase F | Wrapper-chain removal (deploy cleanup, terminal phase) | pending | — | Full phase pending |

Phase B notes: PR #370 routed OpenAI and Anthropic API providers through `lookupCredential(apiKeyService)` with env fallback preserved. ElevenLabs is ALSO already migrated: `src/runtimes/chat/providers/elevenlabs.ts:20` resolves its key via `lookupCredential('elevenlabs')` (env-first with keyring fallback), landed in SHA `ef20d66d` on 2026-04-06 — before this handoff was written — so its prior `pending` listing was a documentation staleness error, corrected in the 2026-07-01 re-grounding below.

The remaining Phase B providers, re-verified against `origin/main` (SHA `c40e2992`) on 2026-07-01, are still OPEN (read `process.env.*` directly, not the resolver):
- Whisper — `src/runtimes/chat/providers/transcription/openai-whisper.ts:23,72` read `process.env.OPENAI_API_KEY` directly.
- Pinecone — `src/runtimes/chat/providers/pinecone.ts:116,392` read `process.env[configuredPineconeApiKeyEnv()]` directly.
- Knowledge MCP — `src/mcp/tools/knowledge.ts:182,260` read `process.env[apiKeyEnv]` directly.
- Health auth — `src/core/health.ts:461` reads `process.env.WHATSOUP_HEALTH_TOKEN` directly.

Phase A (the formal `lookupCredentialTyped` typed API) has not landed yet; the migrated providers (OpenAI, Anthropic, ElevenLabs) use the existing `lookupCredential` shim.

### 2026-07-01 re-grounding (issue #1431)

This handoff was re-verified against `origin/main` at SHA `c40e2992`. Correction: ElevenLabs was wrongly listed as a pending Phase B provider; it has been resolver-routed since 2026-04-06 (`ef20d66d`). The Phase B table and pending list above now reflect actual source state. Phase B remains IN-PROGRESS: 3 of 7 providers migrated (OpenAI, Anthropic, ElevenLabs), 4 still OPEN (Whisper, Pinecone, Knowledge MCP, health auth). No migration code was changed by this re-grounding — the remaining migrations are separate owner-gated security work. The handoff stays OPEN.

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

5. Move health tokens out of env files.
   - Store per-instance health tokens as keyring entries, for example `service=whatsoup_health`, `account=<instance>`.
   - Stop writing and loading `tokens.env` after migration.

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
