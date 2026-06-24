# WhatSoup

Consolidated WhatsApp platform — one process, one Baileys connection, one database, and the canonical MCP tool registry documented in `docs/tools.md`.

## Quick Reference

- **Language:** TypeScript (Node `>=24.0.0 <26`, pinned at `24.15.0` via `.nvmrc` / `package.json#volta.node` / `package.json#packageManager`; native `--experimental-strip-types`, no build step)
- **Test:** `npm test` (vitest, 10s timeout)
- **Typecheck:** `npm run typecheck`
- **Lint:** `npm run guard:lint:src` (ESLint architectural-fitness ring — warn-only on ring rules, fail-closed on errors/config faults; see `docs/architecture/fitness-taxonomy.md`)
- **Agent workflow:** `docs/agent-operating-procedure.md` maps each SDLC phase → the global skill to invoke → the repo command that verifies it. This repo owns no `.claude/skills`; invoke skills by name, don't duplicate them.

## Architecture

- `src/core/` — shared infrastructure (DB, types, access control, messages)
- `src/transport/` — Baileys connection management
- `src/mcp/` — MCP tool registry, socket server, tool implementations
- `src/runtimes/agent/` — Claude Code agent subprocess management
- `src/runtimes/chat/` — Direct LLM API chat (Chat Bot)
- `deploy/` — systemd units (Linux), launchd plists (macOS, generated under `deploy:launchd.generated`), Docker assets, hooks, proxy scripts; `src/fleet/platform.ts` auto-detects `linux-systemd` / `macos-launchd` / `docker` / `linux-no-systemd` and routes service control through the matching backend

## Key Concepts

- **conversation_key** — canonical chat identity, stable across JID aliasing (@s.whatsapp.net vs @lid). All reads query on this. Raw `chat_jid` is kept for sends only.
- **ToolRegistry** — in-process MCP tool declarations with scope enforcement (chat vs global)
- **SocketServer** — per-scope Unix sockets speaking MCP JSON-RPC. Chat-scoped sessions auto-inject deliveryJid; global sessions require explicit chatJid.
- **SessionContext** — per-socket state: tier (global/chat-scoped), conversationKey, deliveryJid
- **Agent decision polls** — blocking user decisions use `AskUserQuestion` so WhatSoup can render a WhatsApp poll and inject the vote back into the waiting turn; non-blocking surveys use MCP `send_poll`. See `docs/runbooks/agent-decision-polls.md`.

## Instance Model

Four independent processes managed by the platform-appropriate service manager — `systemctl --user` against the systemd template unit (`whatsoup@<name>.service`) on Linux, `launchctl` against per-instance plists (`com.whatsoup.<instance>.plist`, generated via `deploy:launchd.generated`) on macOS, or in-process supervision under Docker; `src/fleet/platform.ts` picks the backend:
- `primary-line` — passive MCP-only line for manual oversight (tier: global, no auto-response)
- `operator-agent` — full-access autonomous agent (tier: global)
- `sandbox-agent` — sandboxed per-chat agent (tier: chat-scoped per workspace)
- `chat-bot` — chat API bot, no MCP, no agent

`tier` here is the MCP `SessionContext.tier` (controls tool scope), independent of `agentOptions.sessionScope` (controls agent-session lifetime: `single`/`shared`/`per_chat`).

### Per-Instance Plugin Scoping

Each agent instance controls which Claude Code plugins it loads via `enabledPlugins` in `agentOptions` (config.json) and `.claude/settings.json` (project-level). Plugins disabled at the instance level are not loaded into the session, saving context.

Key files:
- `src/core/settings-template.ts` — default permissions and plugin templates
- `src/core/workspace.ts` — `writePermissionsSettings()`, `ensurePermissionsSettings()`
- `src/fleet/routes/ops.ts` — PATCH handler writes enabledPlugins to both config.json and .claude/settings.json

## Conventions

- ESM throughout, no CommonJS
- Zod for runtime validation
- Pino for structured logging
- Real SQLite in tests (`:memory:` or temp files), real Unix sockets where needed
- Tests mirror source structure under `tests/`
- Run tests with `--pool=forks` for stability: `npx vitest run --pool=forks`

## PR Discipline

**Runbook-and-PR co-update.** When a PR closes a gap that is documented in a runbook (a "not yet wired", "TODO", "not implemented", "runtime gap", or similar marker calling out missing behaviour), the documenting runbook MUST be updated in the same PR. Doc-lying-about-code is a release-blocking defect, not a follow-up. This rule generalises the PR #677/§6 staleness incident.

The fastest check before filing a PR:

```bash
# Are any of the files I'm touching referenced from a runbook line that
# claims the behaviour is "not wired" / "TODO" / "not yet implemented"?
git diff --name-only origin/main..HEAD | xargs -I{} \
  grep -l "not yet wired\|not wired\|TODO\|not yet implemented\|runtime gap" docs/runbooks/ 2>/dev/null
```

If anything turns up, read the matched line in context — if your PR closes the gap it describes, update the runbook in the same diff.

## Documentation

- `docs/configuration.md` — environment variables, instance.json schema, XDG paths, **per-instance plugin scoping**
- `docs/tools.md` — complete MCP tool API reference generated from the registry, including conditional and inline runtime registrations
- `docs/runbook.md` — operational runbook (service management, troubleshooting, recovery)
- `docs/runbooks/agent-decision-polls.md` — portable contract for `AskUserQuestion` poll bridging and MCP `send_poll` usage
- `docs/durability.md` — durability engine design, state machines, recovery algorithms
- `docs/security-handoffs/` — open security handoffs that belong to the WhatSoup application lifecycle
