# MCP & Ops Hygiene

## Problem

The harness-maintenance daily probe surfaces a cluster of MCP and host findings
that are not WhatSoup *code* defects but do degrade the runtime/agent surface:

1. The `whatsoup` MCP proxy fails to connect.
2. The Playwright plugin MCP runs a floating `npx @playwright/mcp@latest`
   (uncontrolled version; bypasses any cooldown).
3. The `render` MCP fails / its local helper is missing.
4. Host drift: Google Chrome apt update pending; Google Drive MCP needs auth.

These span three ownership domains — a WhatSoup MCP registration, Claude-global
plugin config, and host ops — so the fixes are grouped here but land in
different places.

## Evidence (2026-05-30)

- **whatsoup proxy:** registered in **host-level `.mcp.json` files** (NOT the
  WhatSoup repo) — replicated across ~10 of them (`~/.mcp.json` key `whatsoup`,
  `~/.claude/.mcp.json` key `whatsoup-<instance>`, plus `~/agents/*`, `~/LAB/*`)
  with three inconsistent command forms. **Two stacked defects**, not one:
  (1) interpreter `node --experimental-strip-types …` dies on ambient Node 20
  (`node: bad option: --experimental-strip-types`) — the git-hook node trap; the
  `.nvmrc` node (24.15.0) supports the flag, but so does the repo-local `tsx`
  runner regardless of node version. (2) **stale `WHATSOUP_SOCKET`** — `~/.mcp.json`
  pointed at the dead `~/.claude/whatsoup.sock` (old single-instance layout); the
  live socket is the per-instance `~/.local/state/whatsoup/instances/<instance>/whatsoup.sock`
  (`whatsoup@<instance>.service`). Fixing the interpreter alone does NOT restore the
  connection — the socket must also be corrected. Only running the proxy directly
  surfaced defect (2).
- **Playwright:** `@playwright/mcp@latest` in
  `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json`.
  Latest dist-tag = `0.0.75`. This is a claude-plugins-official plugin, not a
  WhatSoup file; editing it directly is overwritten on plugin update.
- **render:** HTTP server `https://mcp.render.com/sse` failing; local helper
  `~/.local/bin/render-mcp` absent.
- **chrome:** installed `147.0.7727.101-1`, candidate `148.0.7778.215-1`.

## Design

### Fix 1 — whatsoup MCP proxy registration (host config — DONE 2026-05-30)

Use the **repo-canonical `tsx` form** the repo already documents in
`scripts/cutover.sh` CUT-08 — NOT a hardcoded node path. Hardcoding
`~/.nvm/versions/node/v24.15.0/bin/node` re-breaks on the next node bump (the
exact version-pin brittleness this program is built to fight); `tsx` runs the
`.ts` proxy independent of the ambient node:
```
"command": "<repo>/node_modules/.bin/tsx",
"args": ["<repo>/deploy/mcp/whatsoup-proxy.ts"],
"env": { "WHATSOUP_SOCKET": "<live per-instance socket>" }
```
…and repoint `WHATSOUP_SOCKET` to the live per-instance socket
(`~/.local/state/whatsoup/instances/<instance>/whatsoup.sock`), not the dead
`~/.claude/whatsoup.sock`.

**Applied 2026-05-30, verified `whatsoup … ✓ Connected`:** corrected the two
active/canonical registrations only — `~/.mcp.json` `[whatsoup]` and
`~/.claude/.mcp.json` `[whatsoup-<instance>]` — to the `tsx` form + live socket
(backups `*.bak-prefix1`). The other ~8 drifted host `.mcp.json` files were left
untouched (deliberate minimal blast radius); they remain on the old node form and
should be normalized opportunistically if those project scopes are in use. **No
WhatSoup code change was needed** — cutover.sh already prescribes the correct
form; the deployed files had simply drifted from it.

### Fix 2 — Playwright MCP pin (Claude-global)

Add a **user-scoped** pinned `playwright` MCP (`@playwright/mcp@0.0.75`) that
shadows the plugin's floating entry, so it survives plugin reinstalls. This is
Claude-global hygiene, tracked under `~/.claude` / machine-config, **not** a
WhatSoup repo change. Revisit the pinned version on a deliberate cadence (the
probe continues to report when a newer version exists, but does not auto-adopt).

### Fix 3 — render MCP resolution (Claude-global)

Decide per actual use: if `render` is unused, **remove** the failing HTTP server
and the dangling local-helper reference from the Claude MCP config (stops the
daily failure noise). If used, re-provision the helper and re-auth. Default:
remove, since the local helper is absent and the HTTP endpoint is failing.

### Fix 4 — host ops runbook

Document, not automate (both need root/interactive):
- **Chrome:** `sudo apt update && sudo apt install --only-upgrade
  google-chrome-stable`.
- **Google Drive MCP:** run the Drive MCP auth flow to restore the connection.

## Implementation plan

1. **whatsoup proxy** (host config — DONE): repoint the active/canonical
   `.mcp.json` registrations to the `tsx` form + live per-instance socket; confirm
   `claude mcp list` → connected. Repo's `cutover.sh` CUT-08 already documents the
   `tsx` form, so no repo code change was needed — the deployed files had drifted
   from it. (If the drift recurs, harden cutover/setup to write the registration
   reproducibly.)
2. **Playwright pin** (Claude-global, no WhatSoup PR): add the pinned user-scoped
   MCP override; verify it shadows the plugin entry; record the pinned version in
   the machine-config notes.
3. **render** (Claude-global): confirm non-use, then remove the server + helper
   reference from the MCP config; verify it no longer appears as failing in
   `claude mcp list`.
4. **runbook** (docs): add `docs/runbooks/host-maintenance.md` (or extend an
   existing ops doc) with the chrome-apt and Drive-reauth procedures and link it
   from the harness-maintenance probe findings.

## Testing / verification

- After Fix 1: `claude mcp list` shows `whatsoup … ✓ Connected`. **(Done 2026-05-30.)**
- After Fix 2: the playwright entry resolves to the pinned version; probe reports
  it as pinned, not floating.
- After Fix 3: no `render` failure line in `claude mcp list` / the probe.
- Runbook items: verified manually when executed (chrome version bump; Drive
  reconnect).

## Scope notes

**Correction (2026-05-30):** Fix 1 turned out to be **host config**, not a
WhatSoup repo change — the registration lives in host `.mcp.json` files and the
repo's `cutover.sh` already prescribes the correct `tsx` form. So *none* of Fixes
1–4 are WhatSoup repo code changes; the only repo artifact is this spec doc itself
(a record/runbook). Fixes 2–4 are Claude-global / host ops, documented here
because the harness-maintenance probe is the thing that surfaces them daily. None
are auto-remediated — the probe reports; a human applies.
