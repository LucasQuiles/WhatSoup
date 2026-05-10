# macOS launchd Deployment

Operator reference for running a self-hosted WhatSoup install on macOS with
`launchd`. This runbook uses placeholders for instance names, keychain names,
ports, project IDs, index names, and local paths so each deployment owns its
environment details.

For deployments that also run Pinecone-backed knowledge search, local
transcription, or vector embedding, see
`docs/runbooks/pinecone-transcription-bridge.md`.

## Assumptions

- The live checkout is an operator-owned path such as `~/LAB/WhatSoup`.
- Each instance has a config directory at
  `~/.config/whatsoup/instances/<instance>/`.
- Secrets are injected by wrapper scripts or a service manager, not stored in
  `config.json`.
- Memory and search settings are canonical under `memory.pinecone`.

## Shell PATH

Interactive shells may not include Homebrew's bin path. Set it before running
Node commands manually:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

Launch agent plists should set the same PATH in `EnvironmentVariables`.

## Services

Use one plist per WhatSoup instance plus one optional fleet plist. Optional
embedding and bridge services can run as separate plists when a deployment uses
local vector embedding or scheduled Pinecone export.

| Plist pattern | Purpose | Typical port |
| --- | --- | --- |
| `com.whatsoup.<agent-instance>.plist` | Agent runtime | instance health port |
| `com.whatsoup.<passive-instance>.plist` | Passive capture/runtime instance | instance health port |
| `com.whatsoup.fleet.plist` | Fleet server, health polling, proxy routing, discovery | `FLEET_PORT` |
| `com.whatsoup.<embed-service>.plist` | Optional local embed service for vector profiles | service-owned |
| `com.whatsoup.<bridge>.plist` | Optional scheduled bridge that drains `fact_export_queue` | none |

Example wrapper chain:

```bash
~/.local/bin/with-pinecone-env \
  ~/.local/bin/with-openai-env \
    /opt/homebrew/bin/node /path/to/WhatSoup/src/bootstrap.ts <instance>
```

Keep wrapper names deployment-owned. The WhatSoup config should only reference
the environment variable names those wrappers export, for example
`memory.pinecone.apiKeyEnv = "PINECONE_API_KEY"` or a tenant-specific key name.

## Instance Configs

Per-instance configs live in `~/.config/whatsoup/instances/<instance>/`.

- `config.json` - instance schema, access mode, health port, agent options,
  memory config, and `enabled`.
- `tokens.env` - per-instance health token, read by fleet until the deployment
  moves to keyring-backed health tokens.
- `auth/` - Baileys session credentials.
- `stdout.log`, `stderr.log` - service output when the plist redirects logs.

Instances with `enabled: false` are skipped by fleet discovery but keep their
config and auth state on disk.

## BYOK Memory Migration

Memory and search settings are canonical under `memory` in `config.json`.
Legacy fields such as `pineconeIndex` and `pineconeAllowedIndexes` are still
read at runtime, but new writes should use `memory.pinecone`.

Safe migration procedure:

```bash
cd ~/LAB/WhatSoup
npm run migrate-memory-config -- --instance <instance>
npm run migrate-memory-config -- --instance <instance> --write
```

The first command is a dry run. The second rewrites only
`~/.config/whatsoup/instances/<instance>/config.json` and creates a
`config.json.bak-*` backup. It does not touch:

- `~/.config/whatsoup/instances/<instance>/auth/`
- `~/.config/whatsoup/instances/<instance>/tokens.env`
- `~/.local/share/whatsoup/instances/<instance>/bot.db`
- provider keychains or external secret stores

That means a successful config migration should not trigger WhatsApp QR re-auth
or provider credential rotation.

Recommended Pinecone guard shape:

```json
{
  "memory": {
    "pinecone": {
      "apiKeyEnv": "PINECONE_API_KEY",
      "projectId": "<pinecone-project-id>",
      "expectedHostSuffix": "-<pinecone-project-id>.svc.<environment>.pinecone.io",
      "index": "<memory-index>",
      "allowedIndexes": []
    }
  }
}
```

Keep `allowedIndexes` empty unless the agent should expose `knowledge_search`.
When enabled, prefer `agentOptions.sandboxPerChat: true`; otherwise explicitly
set `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions: true` after
reviewing the blast radius.

## Data Paths

| Concept | Path |
| --- | --- |
| Per-instance SQLite DB | `~/.local/share/whatsoup/instances/<instance>/bot.db` |
| Fleet token file | `~/.config/whatsoup/fleet-token` |
| Fleet logs | `~/.local/share/whatsoup/fleet-{stdout,stderr}.log` |
| Instance logs | `~/.config/whatsoup/instances/<instance>/{stdout,stderr}.log` |
| Optional bridge logs | deployment-owned path, usually under `~/.local/share/whatsoup/` |

Do not create `bot.db` at the repo root or inside `~/.config/whatsoup/`.
Those are wrong tiers. `.gitignore` covers `*.db` to prevent accidental commit.

## Restart Procedures

Restart fleet only:

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.fleet
tail -F ~/.local/share/whatsoup/fleet-stdout.log
```

Restart one instance:

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.<instance>
tail -F ~/.config/whatsoup/instances/<instance>/stdout.log
```

Expect credential-load or runtime health logs within a few seconds. For agent
instances, a restart interrupts in-flight turns.

## Health Signals

| Surface | Healthy signal | Where to check |
| --- | --- | --- |
| Fleet | `fleet scan complete`; expected instance count | fleet stdout log |
| Agent instance | runtime health stats | instance stdout log |
| Passive/chat instance | credential save or message-processing logs, no repeated auth errors | instance stdout log |
| Disabled instances | `fleet scan: skipping disabled instance` | fleet stdout log |

Fleet emits health-poller warnings when a polled instance is unreachable. If the
instance is intentionally offline, set `enabled: false` and bounce fleet.

## Worktree Discipline

- Run tests from the same checkout used by the plist unless deliberately
  validating a staging checkout.
- Keep generated artifacts under ignored `artifacts/` paths.
- Keep auth, token, DB, and keychain material outside the repo.

## Known Limits

- `KeepAlive -> Crashed` only restarts crashed services. Clean exits do not
  auto-restart unless the plist or supervisor is configured for that behavior.
- WhatSoup does not migrate keychain entries. BYOK config selects environment
  variable names; wrappers or service managers remain responsible for exporting
  those variables.
