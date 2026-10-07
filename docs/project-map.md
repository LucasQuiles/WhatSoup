# Project Map - WhatSoup

Navigation and runtime inventory reviewed: 2026-10-06 at source revision
`59cc562bc`. Verify the relevant implementation before changing behavior.

This map orients future documentation and feature-sweep work. It is a source
tree and docs ownership map, not a replacement for generated work indexes or the source-checked tool and public-surface references.

## Runtime Shape

WhatSoup is one TypeScript/Node application with three runtime types: `passive`,
`agent`, and `chat`. The names below are deployment examples, not a fixed fleet
roster or additional runtime types. Instance names, access modes, session scope,
transports, and health ports come from instance configuration.

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
| `src/transport/` | Baileys, Twilio, Signal and iMessage adapters, connection lifecycle, auth, contract events. | `docs/configuration.md`, `docs/runbooks/twilio-transport.md` |
| `src/mcp/` | Registry, socket server, scopes, tool modules, and helper factories. | `docs/tools.md`, `docs/public-surface.md` |
| `src/runtimes/agent/` | Agent session lifecycle, providers, fallback, handoff distiller, polls, media bridge, response registry. | `docs/runbooks/error-response-workflows.md`, `docs/runbooks/agent-decision-polls.md` |
| `src/runtimes/chat/` | Direct chat runtime, rate limits, context, queueing, provider integrations. | `docs/configuration.md` |
| `src/memory/` | Memory consolidation scheduler and types. | `docs/explainers/byok-memory-config-migration.md` |
| `src/fleet/` | HTTP API, health polling, realtime events, ops routes, credentials, update checks, console serving. | `README.md`, `docs/runbook.md`, `docs/public-surface.md` |
| `console/src/` | Fleet console pages, primitives, design system usage, realtime hooks, API client. | `docs/console-guide.md`, `docs/design-system/README.md` |
| `deploy/` | systemd units, launchd templates, bot-errors services, hooks, setup scripts. | `docs/runbook.md`, `docs/runbooks/macos-launchd-deployment.md` |
| `scripts/` | Guards, doc drift checks, release gates, migrations, maintenance scripts. | `docs/contributing/quality-guardrails-checklist.md`, `docs/architecture/fitness-taxonomy.md` |
| `tools/` | Auxiliary guard/probe packages. | Per-tool README files. |
| `tools/qsesh/` | Python session source adapters, extraction, archive, scan, metrics and distillation. | Source contracts in `qsesh/cli.py`, `qsesh/config.py` and package tests; `package.json` owns `test:qsesh` / `lint:qsesh`. Historical planning snapshots are not current execution instructions. |

## Documentation Roots

| Root | Purpose |
|---|---|
| `docs/runbooks/` | Operational procedures and focused runbooks. |
| `docs/specs/` | Internal design specs that are tracked selectively despite the ignored root. |
| `docs/superpowers/` | Planning, specs, handoffs, and review artifacts indexed by `docs/work-index.*`. |
| `docs/sdlc/` | SDLC state artifacts indexed by `docs/work-index.*`. |
| `docs/design-system/` | Design navigation, v3 history and v3.5 specifications; dated inventories and acceptance records remain evidence at their recorded revision. |
| `docs/reliability-runner/` | Reliability-runner matrices and pending-bead dispositions. |
| `docs/reviews/` | Review findings and code-quality bead registers. |
| `docs/triage/` | Sealed historical issue registry and cluster catalogs; [the triage README](triage/README.md) owns their scope and links to current work discovery. |
| `docs/security-handoffs/` | Security handoffs retained for the application lifecycle. |
| `docs/audits/`, `docs/artifacts/`, `artifacts/`, `.distill/` | Existing tracked and ignored audit/snapshot evidence. These roots are outside the generated work-index scope. Retain provenance and owner decisions; check code consumers before moving even an untracked file. |
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
| Guard and release gates | `scripts/*guard*.ts`, `scripts/*drift*.ts`, package scripts | `docs/contributing/quality-guardrails-checklist.md`, `AGENTS.md` |

## Artifact Ownership

| Artifact class | Canonical handling |
|---|---|
| Generated planning index | Regenerate with `npm run work-index:regen`; do not hand-edit `docs/work-index.*`. |
| Public-surface registry | Update `docs/public-surface.md` with code changes and run `npm run guard:public-surface-drift`. |
| MCP tool docs | Update `docs/tools.md` against tool declarations when the registry changes and run `npm run guard:doc-drift`. |
| Internal tracked docs | Add a row in `docs/publication-audit.md` when covered by the publication guard. |
| Local-only sweep output | `.sweep/<run-id>/` holds local collection intermediates. Reusable evidence and recovery copies belong in the operator's retention-protected durable project-state root; do not commit session logs or private archives. |
| Ignored scratch artifacts | Preserve bytes and a source-to-canonical disposition before pruning. Check live/configured dependencies and the host's cleanup approval requirements; keep evidence whose replacement or retirement is unproven. |

Some local evidence has executable consumers. `scripts/qregistry-loop.ts`
defines `DEFAULT_AUDIT` for an operator-local audit that is not tracked in this
repository. Inspect that constant and the configured input before running the
loop or moving local audit files. Ignored status alone does not make evidence
disposable when an executable consumer still requires it.
Old qSesh review snapshots likewise preserve owner choices and test-fixture
requirements; the checked-in package and its current test runner determine
implemented behavior. The runner's multi-interpreter checks are distinct from
old single-interpreter verification receipts.

## Canonical documentation structure

Use one owner for each fact, with links from other entry points:

| Surface | Owns | Keep elsewhere |
|---|---|---|
| `README.md` | Product overview, setup, usage and high-level API navigation. | Detailed schemas in configuration; operational recovery in runbooks. |
| `AGENTS.md` | Shared repository instructions, commands and verification boundaries. | Tool-specific loading guidance in the short root `CLAUDE.md` router. |
| `docs/current-program.md` | Navigation to current work and its evidence owners. | Backlog and delivery claims in their original issue, plan, Git or runtime record. |
| `docs/configuration.md`, `docs/tools.md`, `docs/public-surface.md` | Configuration, source-checked tool API, and public-surface contract respectively. | Historical examples and proposed interfaces in dated specs/plans. |
| `docs/runbook.md`, `docs/runbooks/` | General operations and focused procedures. | Host-specific evidence in its private operational record. |
| `docs/durability.md`, focused architecture/specification docs | State contracts and required behavior. | Unimplemented requirements remain explicit; source disagreement is a gap, not permission to drop a requirement. |
| `docs/design-system/README.md` | Route to current console implementation, design requirements and dated design evidence. | Old inventories and mockups retain their original baseline. |

Historical reports, reviews, plans and snapshots remain traceable at their existing
paths. Their dates, hashes and decisions are part of the record. They do not become
current instructions merely because a search finds them. Before consolidating a
section, account for every requirement and unique fact in its destination; retain
uncertain material with an explicit scope rather than silently discarding it.

## Refresh Checklist

1. Run `npm run guard:doc-drift`, `npm run guard:public-surface-drift`, and
   `npm run guard:work-index`.
2. Run the artifact-sweep dry run and review `manifest.json`, `manifest.md`,
   `backup-reference.json`, and residuals under `.sweep/<run-id>/`.
3. Inventory source roots before updating docs; do not infer feature ownership
   from stale planning prose.
4. Promote missing canonical docs with `git add -f` only when the ignored root
   is intentionally selective.
5. Update `docs/current-program.md` when objectives, ownership, blockers or delivery
   boundaries change. Generated-index changes alone do not require a router edit.
