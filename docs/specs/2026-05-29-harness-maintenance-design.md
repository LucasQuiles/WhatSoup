# Harness & Dependency Maintenance

## Problem

The WhatSoup runtime host depends on three agent harnesses — the Claude
CLI, the Codex CLI, and the OpenCode CLI — plus a wide surface of supporting
packages, MCP servers, plugins, and system tools. None of these are kept
current automatically. Drift is discovered only by accident, usually when
something breaks.

Two concrete failures motivated this work:

1. **Silent staleness.** The Claude CLI was found at `2.1.91` while the
   published release was `2.1.156` — 65 patch versions behind. The Codex CLI
   had a stale root-owned fallback at `0.87.0` shadowing the canonical
   NVM-managed `0.130.0`. No signal surfaced either gap.

2. **Unpinned model inheritance.** WhatSoup-triggered agent sessions spawn the
   Claude CLI with no `--model` flag (confirmed from a live process and from
   `src/runtimes/agent/providers/claude.ts`, which only passes `--model` when
   the instance sets one — none do). The effective model therefore tracks
   whatever default the installed CLI ships. A silent CLI bump can change the
   model used by production sessions with no record of it having happened.

A naive fix — "run the updaters on a timer" — introduces a worse problem:
**supply-chain exposure**. The Codex CLI installs from npm, and the host
currently has no `~/.npmrc`, `minimum-release-age` unset, and `before=null`.
A blind `@latest` would install a release published seconds earlier, which is
the dominant npm attack pattern (compromised-maintainer publish, yanked within
hours). The maintenance system must therefore be safe by construction, not just
convenient.

## Evidence (inventory, 2026-05-29)

Captured from the live runtime host.

### Harnesses (auto-fix candidates)
| Harness | Installed | Latest | Install method | npm? |
|---------|-----------|--------|----------------|------|
| Claude CLI | 2.1.91 → 2.1.156 | 2.1.156 | native installer (`claude install`) | no |
| Codex | 0.130.0 → 0.135.0 (NVM); 0.87.0 (system fallback) | 0.135.0 | npm global on NVM node 24.13.0 | **yes** |
| OpenCode | 1.15.10 | — | standalone ELF binary (`opencode upgrade`) | no |

Only Codex is an npm package; Claude and OpenCode are vendor binaries with
their own update channels. The Codex npm package declares **no install
scripts** (`scripts: {}`), so it can be installed with `--ignore-scripts`
safely.

### Runtimes & load-bearing surface
- **Node:** system `v20.20.2`; NVM `v20.20.0`, `v22.22.3`, `v24.13.0`
  (Codex's node, npm `11.8.0`), `v24.15.0` (WhatSoup's `.nvmrc` pin, npm
  `11.12.1`). npm ≥ 11.5 supports `minimum-release-age`.
- **Python:** system `3.12.3` (drives DreamMachine + many `~/.claude/scripts`
  and `~/bin` fleet jobs).
- **Package managers:** npm only (no bun, no pnpm); corepack present.
- **Runtime externals:** `google-chrome` (apt), `ffmpeg 6.1.1` (apt).
- **Key CLI tools:** `gh 2.45.0`, `jq 1.7`, `ripgrep 14.1.0`, `sqlite3 3.45.1`,
  `git 2.43.0` (all apt/system).
- **MCP servers (14):** local binaries (`pinecone-mcp`, `google-workspace-mcp`,
  `playwright-mcp`), plugin-bundled (`tmup`, `episodic-memory`,
  `superpowers-chrome`, `microsoft_365`, `playwright` via
  `npx @playwright/mcp@latest`), and remote/HTTP (Gmail, Calendar, Drive,
  microsoft-learn, render). **Live findings at inventory time:** the `whatsoup`
  proxy and `render` MCP were failing to connect; the `playwright` plugin MCP
  uses a floating `@latest` that bypasses any cooldown.
- **Claude plugins:** installed set spans 6 marketplaces
  (`claude-plugins-official`, `microsoft-365-dev`, `ralph-loop-v2-dev`,
  `sdlc-os-dev`, `superpowers-marketplace`, `tmup-dev`).

### Existing infrastructure this builds on
- Systemd `--user` timers are the established scheduling mechanism (dozens
  live: `fleet-progress`, `whatsapp-alert-sweep`, `health-report`,
  `session-lifecycle-monitor`, …). See
  `2026-03-31-systemd-unit-resilience-design.md`.
- `deploy/` already ships unit files (`whatsoup-reply-guarantee.{service,timer}`,
  `whatsoup@.service`) and `setup.sh`.
- The alert channel is `$HOME/.local/bin/whatsapp-alert`; see
  `2026-04-03-whatsapp-alert-infrastructure-design.md`.
- The Node version is a single source of truth in `.nvmrc`, guarded by
  `scripts/check-node-pin-consistency.ts`.

## Goals

- Detect version drift across the full harness/package/plugin/tool surface,
  daily, with no manual action.
- **Auto-fix** the three harnesses, with verification and rollback, so a bad
  release cannot silently degrade the runtime.
- Make every update **supply-chain safe**: nothing newer than a 7-day cooldown
  is adopted, install scripts are suppressed where possible, and provenance is
  verified.
- **Detect-and-alert** (never auto-mutate) for the broader surface: runtimes,
  apt criticals, MCP servers, plugins, npm globals — including health and
  floating-version findings.
- Fail closed and observable: any failure leaves no partial state, fires an
  alert, and surfaces in fleet health.

## Non-goals

- Auto-upgrading Node majors, system Python, apt packages, or WhatSoup's own
  dependency tree. These need human review and the repo PR flow.
- Changing how WhatSoup selects models. (A follow-up may pin a model
  explicitly; this spec only *surfaces* the unpinned-inheritance risk.)
- Managing harness *configuration* — only versions.

## Design

The system is one script driven by one systemd timer, organized around a
two-tier risk model and a shared supply-chain gate.

### Risk tiers

**Tier 1 — auto-fix (verified + rollback):** `claude`, `codex`, `opencode`.
**Tier 2 — detect + alert only:** everything else, via discovery probes.

Tier 1 is a fixed, hand-audited set because each member has a bespoke
update/rollback/smoke procedure. Tier 2 is data-driven so the watched surface
can grow without code changes.

### Step 1 — Supply-chain gate (npm path)

A managed `~/.npmrc` is added to `deploy/` as `npmrc.hardened` and applied by
`setup.sh`:

```ini
registry=https://registry.npmjs.org/
minimum-release-age=10080      ; 7 days, in minutes
audit=true
fund=false
```

The script enforces the same 7-day cooldown independently (it does not trust
the global config to be present), and for any npm install:

1. Resolve the exact target version from the registry.
2. Reject it if `time[version]` is younger than 7 days → hold + alert
   (`holding codex 0.x.y, published Nd ago`).
3. Install the **exact pinned version** with `--ignore-scripts`.
4. Run `npm audit signatures` (provenance/signature check) and `npm audit`;
   a new high/critical finding aborts the update → alert.

### Step 2 — Tier 1 update procedures

Each harness defines `current → update → smoke → rollback`:

| Harness | Update | Smoke | Rollback |
|---------|--------|-------|----------|
| claude | `claude install latest` | `claude --version` parses | `claude install <prev>` |
| codex | gated npm install to NVM node 24.13.0 global | `codex --version` via direct NVM binary (`CODEX_NO_DEFAULTS=1`) | `npm i -g @openai/codex@<prev> --ignore-scripts` |
| opencode | `opencode upgrade` | `opencode --version` parses | `opencode upgrade <prev>` |

The pre-update version is captured first. If the smoke check fails, the
rollback runs and the failure is alerted. A long-running session keeps its
loaded binary; only new spawns pick up the change.

### Step 3 — Tier 2 discovery probes

Each probe lists installed components, compares against available, and emits
findings. All are detect-only.

| Probe | Source | Findings |
|-------|--------|----------|
| `npm-global` | `npm ls -g` per managed node | outdated (cooldown-aware) |
| `claude-plugins` | `installed_plugins.json` + marketplace refs | update-available, floating refs |
| `mcp-servers` | `claude mcp list` | **connection health**, floating `@latest` |
| `local-bin` | `pinecone-mcp`, `google-workspace-mcp`, `playwright-mcp` | version drift |
| `apt` | curated list (gh, jq, ripgrep, sqlite3, git, ffmpeg, google-chrome) | `apt list --upgradable` (root needed) |
| `runtime` | node (`.nvmrc`), python3, npm | drift / EOL |

The probe set and the apt curated list live in `deploy/managed-components.json`
so the surface is extensible without editing the script.

### Step 4 — Scheduling

`deploy/harness-maintenance.{service,timer}`, mirroring
`whatsoup-reply-guarantee.{service,timer}`:

```ini
# .timer
[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=900
```

```ini
# .service
[Service]
Type=oneshot
ExecStart=%h/LAB/WhatSoup/deploy/scripts/harness-maintenance.sh
```

Daily, off-peak, `Persistent=true` so a missed run (host asleep) catches up.

### Components / files

All under `deploy/`, shipped via the WhatSoup repo PR:

- `deploy/scripts/harness-maintenance.sh` — entrypoint: inventory → Tier-1
  gated update → Tier-2 probes → write state + alert. Supports `--check`
  (dry-run, no mutation) and `--json`.
- `deploy/scripts/lib/` — small helpers (version compare, registry age lookup,
  alert wrapper) following the existing `deploy/hooks/lib` pattern.
- `deploy/harness-maintenance.service`, `deploy/harness-maintenance.timer`.
- `deploy/npmrc.hardened`.
- `deploy/managed-components.json` — Tier-2 manifest + apt curated list.
- `deploy/setup.sh` — wire install of the unit + `~/.npmrc`.

### Data flow & observability

State and log at `$HOME/.cache/whatsoup/harness-maintenance/{state.json,run.log}`.
`state.json` records, per run: timestamp, each component's before/after version,
actions taken, held-back versions (with age), and probe findings. Alerts fire
through `whatsapp-alert` on any update, rollback, hold, health failure, or new
vulnerability. `health-report` reads `state.json` so drift and failures surface
in fleet health.

### Error handling

Fail-closed and idempotent. Any step failure: rollback if mid-update, no
partial `state.json`, alert fired, nonzero exit (systemd marks the unit failed
→ visible in fleet health). The registry/network calls have timeouts; a probe
that errors is reported as a probe failure, not silently skipped.

## Testing

- `shellcheck` on all shell, in CI alongside the existing `scripts/check-*.sh`.
- Unit tests for version-compare and the 7-day cooldown boundary (fixture
  registry responses; no network).
- `--check` dry-run exercised in CI: asserts it reports drift and mutates
  nothing.
- A guard (`scripts/*-guard.ts` pattern) asserting `deploy/managed-components.json`
  parses and every Tier-1 entry has update/smoke/rollback defined.

## Rollout

1. Land the PR (script + units + manifest + npmrc + tests + this spec).
2. Apply `npmrc.hardened`; install the unit via `setup.sh`; run once with
   `--check` and review `state.json`.
3. Enable the timer. First live run reconciles current drift (Codex
   0.130→0.135 is the only Tier-1 gap; Claude/OpenCode already current after
   the manual updates that motivated this work).

## Open questions

- Should the `playwright` plugin MCP's floating `@latest` be pinned as part of
  this PR, or tracked as a separate finding the probe simply reports? (Leaning:
  report now, pin in a follow-up to keep this PR focused.)
- Should `state.json` drift findings also post a periodic digest (e.g. weekly)
  rather than only on-change alerts? (Leaning: on-change only for v1.)
