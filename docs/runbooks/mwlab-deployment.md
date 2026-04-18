# mwlab WhatSoup Deployment

Operator reference for the live WhatSoup install on `mwlab`
(`michaels-mac-studio`, Tailscale `100.84.79.77`). Covers the repo layout,
launchd services, log locations, canonical data paths, and restart
mechanics. For the Phase 3 WhatsApp hybrid ingestion pipeline into
`mw-mind`, see `mwlab-transcription-pinecone.md`.

## Repo and branch

Production runs from a worktree, not the main checkout:

| Role | Path | Branch |
| --- | --- | --- |
| Canonical checkout | `~/LAB/WhatSoup` | `main` |
| Live service checkout | `~/LAB/WhatSoup/.worktrees/docker` | `feature/transcription-pinecone-readiness` |

All launchd plists point at the worktree. Do not `git clean`, force-reset,
or delete the worktree directory without coordinating with the operator —
live services resolve their source files through it.

## Node and PATH

Every shell command that runs `node`, `npm`, or `npx` on `mwlab` must
export Homebrew's bin path first:

```bash
export PATH=/opt/homebrew/bin:$PATH
```

The launchd plists already set PATH via `EnvironmentVariables`. This only
affects interactive SSH sessions.

## Services (launchd, user scope)

Four `com.whatsoup.*` plists and two `com.mwlab.mw-mind-*` plists are
loaded at login. Each `KeepAlive -> Crashed` so a clean exit will not
restart automatically; use `launchctl kickstart -k` to bounce.

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

- `config.json` — instance schema (type, accessMode, healthPort, agentOptions, `enabled?: boolean`).
- `tokens.env` — per-instance health token, read by the fleet.
- `auth/` — Baileys session credentials.
- `stdout.log`, `stderr.log` — captured launchd output.

Instances with `enabled: false` are skipped by fleet discovery (no health
polling, no proxy routing) but keep their config on disk. Use this to
take an instance out of rotation without deleting it.

## Canonical data paths

| Concept | Path |
| --- | --- |
| Per-instance SQLite DB | `~/.local/share/whatsoup/instances/<name>/bot.db` |
| Fleet token file | `~/.config/whatsoup/fleet-token` |
| Fleet logs | `~/.local/share/whatsoup/fleet-{stdout,stderr}.log` |
| mw-mind bridge logs | `~/.local/share/mw-mind/whatsapp-bridge-{stdout,stderr}.log` |
| mw-mind WhatSoup MCP proxy | `/Users/mw/LAB/WhatSoup/.worktrees/docker/deploy/mcp/whatsoup-proxy.ts` |

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

- Do not commit to the `docker` worktree from outside an operator session —
  pre-commit hooks invoke `npx lint-staged` and fail under bare SSH unless
  `PATH=/opt/homebrew/bin:$PATH` is exported.
- Untracked `scripts/p36-*` probes are Phase 3 investigation artifacts —
  do not delete. See `mwlab-transcription-pinecone.md`.
- `artifacts/plan-hardening/…` is the run-scoped evidence root for this
  plan family. Covered by `.gitignore`.

## Known limitations

- All plists have `KeepAlive -> Crashed` only. Clean-exit services do not
  auto-restart. No supervisor watches for stalled instances (no fleet-level
  circuit breaker today).
- `WHATSOUP_HEALTH_TOKEN` for mw-bot is stored plaintext in the plist.
  Migration to a keychain wrapper (mirroring `with-pinecone-env`) is
  tracked as a separate approved-only ops rotation and is not executed
  by the standard hardening runbook.
