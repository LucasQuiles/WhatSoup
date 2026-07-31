# Host-Specific WhatSoup Deployment

Operator reference for a host-specific WhatSoup install. Covers the repo layout,
launchd services, log locations, canonical data paths, and restart mechanics.
For the companion WhatsApp transcription bridge, see the matching
host-specific transcription bridge runbook.

> Supersession note, 2026-06-13: this runbook contains historical
> live-from-checkout assumptions. When the service runs from a non-git release
> snapshot, use `docs/runbooks/release-deployment.md` as the source-controlled
> release/re-cut workflow and verify the active launchd `ProgramArguments`
> before acting. A source PR merge does not update a running release snapshot.

## Repo and branch

Production runs from the canonical checkout (as of 2026-04-18 closeout):

| Role | Path | Branch |
| --- | --- | --- |
| Canonical checkout / live service | `~/LAB/WhatSoup` | `main` |

All launchd plists and `~/.local/bin/whatsoup*` symlinks resolve through
the main checkout. The prior `.worktrees/docker` worktree was removed
during the 2026-04-18 closeout — do not reintroduce it without a matching
plist and symlink update.

## Node and PATH

Every shell command that runs `node`, `npm`, or `npx` on `mwlab` must
export Homebrew's bin path first:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

The launchd plists already set PATH via `EnvironmentVariables`. This only
affects interactive SSH sessions.

## Services (launchd, user scope)

This runbook is host-specific to an mwlab deployment. It describes the expected
plist shape for that host; it is not evidence that the same bridge is installed
on maclab, nucles, or any other WhatSoup instance.

Four `com.whatsoup.*` plists and two `com.mwlab.mw-mind-*` plists are loaded at
login when this deployment is installed. Instance plists generated at or after
the #2682 fix use `KeepAlive -> {Crashed: true, SuccessfulExit: false}` with
`ThrottleInterval 60`, so any non-zero exit (including the deliberate `exit(1)`
on reconnect-exhaustion or unhandled rejection) relaunches automatically.
Plists generated BEFORE that fix are `Crashed`-only and strand instances on a
clean `exit(1)` — the cause of the 2026-07-29 21h bot outage on this host; regenerate and
reload them. `launchctl kickstart -k` still bounces a service manually.

| Plist | Purpose | Listening port |
| --- | --- | --- |
| `com.whatsoup.mw-bot.plist` | mw-bot agent runtime (Claude Code subprocess, per-chat sessions) | 9090 |
| `com.whatsoup.mw-cell.plist` | mw-cell passive capture instance (mw's personal phone) | 9091 |
| `com.whatsoup.whatsoup-fleet.plist` | Fleet server (health-poll, http-proxy, discovery) | 9099 |
| `com.mwlab.mw-mind-embed.plist` | mw-mind embed service | — |
| `com.mwlab.mw-mind-whatsapp-bridge.plist` | `mw-mind` scheduled bridge (`StartInterval=600`) | — |

The mw-bot plist wraps the node invocation with two keychain loaders
that export secrets from `~/.config/mwlab-secrets.keychain-db`:

```
/Users/mw/.local/bin/with-pinecone-env \
  /Users/mw/.local/bin/with-openai-env \
    /opt/homebrew/bin/node … src/bootstrap.ts mw-bot
```

## Instance configs

Per-instance configs live in `~/.config/whatsoup/instances/<name>/`.

- `config.json` — instance schema (type, accessMode, healthPort, agentOptions, `memory`, `enabled?: boolean`).
- `tokens.env` — per-instance health token, read by the fleet.
- `auth/` — Baileys session credentials.
- `stdout.log`, `stderr.log` — captured launchd output.

Instances with `enabled: false` are skipped by fleet discovery (no health
polling, no proxy routing) but keep their config on disk. Use this to
take an instance out of rotation without deleting it.

### BYOK memory config migration

Memory/search settings are canonical under `memory` in `config.json`.
Legacy fields such as `pineconeIndex` and `pineconeAllowedIndexes` are
still read at runtime, but new writes should use `memory.pinecone`.

Safe migration procedure:

```bash
cd ~/LAB/WhatSoup
npm run migrate-memory-config -- --instance mw-bot
npm run migrate-memory-config -- --instance mw-bot --write
```

The first command is a dry-run. The second rewrites only
`~/.config/whatsoup/instances/mw-bot/config.json` and creates a
`config.json.bak-*` backup. It does not touch:

- `~/.config/whatsoup/instances/mw-bot/auth/`
- `~/.config/whatsoup/instances/mw-bot/tokens.env`
- `~/.local/share/whatsoup/instances/mw-bot/bot.db`
- `~/.config/mwlab-secrets.keychain-db`

So the migration should not trigger WhatsApp QR re-auth or provider
credential rotation.

For mwlab, keep `memory.pinecone.apiKeyEnv` as `PINECONE_API_KEY`
unless the launchd wrapper is also updated to export a different BYOK env
var. Set `memory.pinecone.projectId` to `nf9hzvy` and
`memory.pinecone.expectedHostSuffix` to
`-nf9hzvy.svc.aped-4627-b74a.pinecone.io` so same-name indexes in other
projects fail closed with `project_mismatch`.

Reference docs:

- `docs/configuration.md`
- `docs/explainers/byok-memory-config-migration.md`
- `docs/releases/2026-04-26-byok-memory-config-migration.md`

## Canonical data paths

| Concept | Path |
| --- | --- |
| Per-instance SQLite DB | `~/.local/share/whatsoup/instances/<name>/bot.db` |
| Fleet token file | `~/.config/whatsoup/fleet-tokens.json` (`active`) |
| Fleet logs | `~/.local/share/whatsoup/fleet-{stdout,stderr}.log` |
| mw-mind bridge logs, if deployed | `~/.local/share/mw-mind/whatsapp-bridge-{stdout,stderr}.log` |
| mw-mind WhatSoup MCP proxy | `/Users/mw/LAB/WhatSoup/deploy/mcp/whatsoup-proxy.ts` |

Do not create `bot.db` at the repo root or inside `~/.config/whatsoup/…`
— those paths are wrong tiers. `.gitignore` covers `*.db` to prevent
accidental commit.

## Restart procedures

### Restart fleet only

Safe at any time — does not touch authenticated instances.

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.whatsoup-fleet
tail -F ~/.local/share/whatsoup/fleet-stdout.log | head -60
```

Expect to see `fleet scan complete count=<n>`, `fleet server listening`,
`realtime poller started` within ~1 second.

### Restart mw-bot

Bounces the Claude Code subprocess; any in-flight chat turns are
interrupted. Coordinate with Michael before running.

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.mw-bot
tail -F ~/.config/whatsoup/instances/mw-bot/stdout.log
```

Expect `Credentials saved` and recurring `agent runtime health stats`
within ~10 seconds of restart.

### Restart mw-cell

Passive capture — safe to bounce.

```bash
launchctl kickstart -k gui/$(id -u)/com.whatsoup.mw-cell
tail -F ~/.config/whatsoup/instances/mw-cell/stdout.log
```

## Health signals

| Surface | Healthy signal | Where to check |
| --- | --- | --- |
| Fleet | `fleet scan complete` every 60s; `count >= 2` | `fleet-stdout.log` |
| mw-bot agent | `agent runtime health stats` every 60s | `instances/mw-bot/stdout.log` |
| mw-cell | `Credentials saved` events; no repeated auth errors | `instances/mw-cell/stdout.log` |
| Ghost-instance suppression | `fleet scan: skipping disabled instance` once per cycle for any `enabled: false` entry | `fleet-stdout.log` |

Fleet emits `health-poller … failures: <n>` at `level: 40` when a
polled instance is unreachable. If that name is not expected, add
`enabled: false` to its `config.json` and bounce the fleet.

## Worktree discipline

- Always `export PATH=/opt/homebrew/bin:$PATH` before `npm`/`npx`/`node`
  commands over SSH so the pre-commit hook can resolve `npx lint-staged`.
- The legacy `scripts/p36-*` evidence probes have been removed; the
  productionized path is `npm run backfill-enrichment -- --strict`. See
  `mwlab-transcription-pinecone.md`.
- `artifacts/plan-hardening/…` is the run-scoped evidence root for this
  plan family. Covered by `.gitignore`.

## Known limitations

- Plists deployed before the #2682 fix have `KeepAlive -> Crashed` only, so
  clean-exit services do not auto-restart until regenerated (newly generated
  plists add `SuccessfulExit: false` + `ThrottleInterval 60`). No supervisor
  watches for stalled instances (no fleet-level circuit breaker today).
- `WHATSOUP_HEALTH_TOKEN` for mw-bot is loaded at runtime from the mwlab
  secrets keychain (`~/.config/mwlab-secrets.keychain-db`, service
  `whatsoup-health-token`, account `mw`) via the `with-health-token`
  wrapper. Rotated out of plaintext plist storage on 2026-04-19
  (F3/T10–T13 per `/Users/q/.claude/plans/whatsoup-followups.md`).
