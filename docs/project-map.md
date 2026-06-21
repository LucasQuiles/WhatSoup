# Project Map - WhatSoup

Last refreshed: 2026-06-20.

This map orients future documentation and feature-sweep work. It is a source
tree and docs ownership map, not a replacement for generated guards such as
`docs/work-index.*`, `docs/tools.md`, or `docs/public-surface.md`.

## Runtime Shape

WhatSoup is one TypeScript/Node application with four instance roles:

| Role | Runtime | Notes |
|---|---|---|
| `primary-line` | passive runtime | MCP-only oversight line. |
| `operator-agent` | agent runtime | Global-scope autonomous agent. |
| `sandbox-agent` | agent runtime | Chat-scoped sandboxed agent sessions. |
| `chat-bot` | chat runtime | Direct API chat bot without MCP agent tools. |

Service control is platform-specific and routed by `src/fleet/platform.ts`:
Linux systemd template units, macOS launchd plists, Docker supervision, or a
no-systemd fallback.

## Source Roots

| Root | Contents | Primary docs |
|---|---|---|
| `src/core/` | Database, message parsing, access policy, send pipeline, durability, scheduler, substrate. | `docs/durability.md`, `docs/reply-guarantee.md`, `docs/runbooks/substrate-slice-1.md` |
| `src/transport/` | Baileys and Twilio transport adapters, connection lifecycle, auth, contract events. | `README.md`, `docs/runbooks/twilio-transport.md` |
| `src/mcp/` | Registry, socket server, scopes, 20 documented tool modules, and helper factories. | `docs/tools.md`, `docs/public-surface.md` |
| `src/runtimes/agent/` | Agent session lifecycle, providers, fallback, handoff distiller, polls, media bridge, response registry. | `docs/runbooks/error-response-workflows.md`, `docs/runbooks/agent-decision-polls.md` |
| `src/runtimes/chat/` | Direct chat runtime, rate limits, context, queueing, provider integrations. | `docs/configuration.md` |
| `src/memory/` | Memory consolidation scheduler and types. | `docs/explainers/byok-memory-config-migration.md` |
| `src/fleet/` | HTTP API, health polling, realtime events, ops routes, credentials, update checks, console serving. | `README.md`, `docs/runbook.md`, `docs/public-surface.md` |
| `console/src/` | Fleet console pages, primitives, design system usage, realtime hooks, API client. | `docs/console-guide.md`, `docs/design-system/README.md` |
| `deploy/` | systemd units, launchd templates, bot-errors services, hooks, setup scripts. | `docs/runbook.md`, `docs/runbooks/macos-launchd-deployment.md` |
| `scripts/` | Guards, doc drift checks, release gates, migrations, maintenance scripts. | `docs/contributing/quality-guardrails-checklist.md`, `docs/architecture/fitness-taxonomy.md` |
| `tools/` | Auxiliary guard/probe packages. | Per-tool README files. |

## Documentation Roots

| Root | Purpose |
|---|---|
| `docs/runbooks/` | Operational procedures and focused runbooks. |
| `docs/specs/` | Internal design specs that are tracked selectively despite the ignored root. |
| `docs/superpowers/` | Planning, specs, handoffs, and review artifacts indexed by `docs/work-index.*`. |
| `docs/sdlc/` | SDLC state artifacts indexed by `docs/work-index.*`. |
| `docs/design-system/` | SOUP v3 design program, inventories, specs, and implementation evidence. |
| `docs/reliability-runner/` | Reliability-runner matrices and pending-bead dispositions. |
| `docs/reviews/` | Review findings and code-quality bead registers. |
| `docs/security-handoffs/` | Security handoffs retained for the application lifecycle. |
| `.sweep/` | Ignored local artifact-sweep manifests, collected copies, and backups. |

## Feature Inventory

| Feature area | Runtime evidence | Documentation evidence |
|---|---|---|
| MCP registry and tools | `src/mcp/register-all.ts`, `src/mcp/registry.ts`, `src/mcp/tools/*.ts` | `docs/tools.md`, `docs/public-surface.md` |
| Message send pipeline | `src/core/send-pipeline.ts`, `src/core/outbound-sends.ts`, `src/core/durability.ts` | `docs/runbook.md`, `docs/reply-guarantee.md`, `docs/durability.md` |
| Agent provider fallback | `src/runtimes/agent/fallback-*.ts`, `runtime.ts`, `session.ts` | `docs/configuration.md`, `docs/runbooks/error-response-workflows.md` |
| Handoff distiller | `src/runtimes/agent/handoff-*.ts` | `docs/specs/2026-06-16-handoff-distiller-wiring-design.md`, `docs/superpowers/plans/2026-06-16-handoff-distiller-wiring.md` |
| AskUserQuestion poll bridge | `src/runtimes/agent/pending-poll-*`, `poll-resolution.ts`, MCP `send_poll` | `docs/runbooks/agent-decision-polls.md`, `docs/tools.md` |
| Fleet control plane | `src/fleet/index.ts`, `src/fleet/routes/*.ts`, `src/fleet/websocket-server.ts` | `README.md`, `docs/public-surface.md`, `docs/runbook.md` |
| Console workflows | `console/src/pages/*`, `console/src/components/*`, `console/src/hooks/*` | `docs/console-guide.md`, `docs/design-system/README.md` |
| Design system primitives | `console/src/components/primitives/*.tsx`, `console/src/styles/*.css` | `docs/design-system/03-spec/`, `docs/design-system/06-implementation/` |
| Configuration and BYOK memory | `src/config*.ts`, `src/core/agent-config-validator.ts`, `src/lib/pinecone-project-guard.ts` | `docs/configuration.md`, `docs/explainers/byok-memory-config-migration.md` |
| Bot-errors reliability services | `deploy/scripts/bot-errors-*.py`, `deploy/bot-errors-*.service`, guard scripts | `deploy/scripts/README-bot-errors.md`, `docs/runbooks/fleet-bot-hardening-standard.md` |
| Guard and release gates | `scripts/*guard*.ts`, `scripts/*drift*.ts`, package scripts | `docs/contributing/quality-guardrails-checklist.md`, `CLAUDE.md` |

## Artifact Ownership

| Artifact class | Canonical handling |
|---|---|
| Generated planning index | Regenerate with `npm run work-index:regen`; do not hand-edit `docs/work-index.*`. |
| Public-surface registry | Update `docs/public-surface.md` with code changes and run `npm run guard:public-surface-drift`. |
| MCP tool docs | Update generated `docs/tools.md` when the registry changes and run `npm run guard:doc-drift`. |
| Internal tracked docs | Add a row in `docs/publication-audit.md` when covered by the publication guard. |
| Local-only sweep output | Keep under ignored `.sweep/<run-id>/`; do not commit collected session logs or local artifact archives. |
| Ignored scratch artifacts | Archive to a sweep run before pruning; keep tracked `artifacts/` evidence files unless a replacement is explicit. |

## Refresh Checklist

1. Run `npm run guard:doc-drift`, `npm run guard:public-surface-drift`, and
   `npm run guard:work-index`.
2. Run the artifact-sweep dry run and review `manifest.json`, `manifest.md`,
   `backup-reference.json`, and residuals under `.sweep/<run-id>/`.
3. Inventory source roots before updating docs; do not infer feature ownership
   from stale planning prose.
4. Promote missing canonical docs with `git add -f` only when the ignored root
   is intentionally selective.
5. Update `docs/current-program.md` after the generated index changes.
