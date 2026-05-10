# WhatSoup Process-Environment Secret Exposure

**Owner:** WhatSoup application/runtime  
**Discovered:** 2026-05-09 during mwlab host hardening  
**Status:** OPEN  
**Severity:** medium-high  
**Canonical host-context pointer:** private MESH tracker `mwlab/aqs-2026-05-09/handoff-whatsoup-env-secrets.md`

This is a WhatSoup bead, not a mwlab host-hardening task. Firewall, sshd, Tailscale ACL, FileVault, Ollama, Caddy, and machine reboot posture stay in the MESH and machine-config trackers.

## Finding

WhatSoup secrets are exposed through process environments on mwlab.

The live launchd plists do not place `OPENAI_API_KEY`, `PINECONE_API_KEY`, or `WHATSOUP_HEALTH_TOKEN` directly in their `EnvironmentVariables` dictionaries. The exposure comes from wrapper chains that read secrets from keychain, export them, and `exec` Node:

`with-pinecone-env -> with-openai-env -> with-health-token -> node ... bootstrap.ts`

That leaves the parent WhatSoup Node processes visible to same-user process inspection. WhatSoup also intentionally passes `OPENAI_API_KEY` to many child agent processes through `buildChildEnv()`.

Concrete attacker model: a malicious or compromised process already running as the same macOS user can read sibling process env/argv with `ps eww`. This is a local same-user lateral-exposure issue, not a public internet or LAN exposure.

## Affected Runtime Objects

| Object | Current behavior |
|---|---|
| `com.whatsoup.mw-bot.plist` on mwlab | Starts wrapper chain before Node. |
| `com.whatsoup.personal.plist` on mwlab | Starts wrapper chain before Node. |
| `with-pinecone-env` | Exports `PINECONE_API_KEY`, then execs child. |
| `with-openai-env` | Exports `OPENAI_API_KEY`, then execs child. |
| `with-health-token` | Exports `WHATSOUP_HEALTH_TOKEN`, then execs child. |
| `bootstrap.ts mw-bot` and `bootstrap.ts personal` | Parent processes expose all three named secrets through env. |
| Agent child processes | Many inherit `OPENAI_API_KEY` through `buildChildEnv()`. |

## Repo Evidence

Start the bead with these files:

- `src/lib/keyring.ts` - env-first credential lookup and missing mwlab keychain path/account support.
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
   - mwlab macOS: support non-secret config for the dedicated mwlab secrets keychain path.
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
- Live mwlab verification: `ps eww` over WhatSoup parent and child PIDs returns no target secret env names.

## Boundaries

This note should not absorb:

- mwlab host posture, Tailscale ACL, FileVault, sshd, AirPlay, Docker, or reboot-survival work.
- Ollama gate, Caddy, sidecar, or token-rotation work.
- GitHub issue filing or external reporting. Those require explicit approval.
