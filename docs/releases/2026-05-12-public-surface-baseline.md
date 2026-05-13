# 2026-05-12 Public-Surface Baseline

## Summary

This release note bootstraps the public-surface registry at `docs/public-surface.md`.
The registry is advisory until the v1.0.0 baseline cut, then becomes the source of truth
for compatibility and deprecation checks.

## Public Surface Additions

- `docs/public-surface.md` now tracks the public HTTP, health, WebSocket, MCP, config,
  environment, npm-script, runtime-mode, deploy-artifact, on-disk-artifact, and console
  workflow surfaces.
- Module-level MCP tool groups are public units; per-tool schemas remain canonical in
  `docs/tools.md`.
- Console workflows are public by operator behavior, not by internal React component
  structure.

## Deprecations

- `http:fleet.legacy-query-token` remains available during the warning window, but root
  fleet tokens in `?token=<root>` are scheduled for removal in v2.0.0 after 2026-06-30.
  Use Bearer root-token auth, `/api/auth-ticket`, or `/api/ws-ticket` instead.
- `config:instance_config.memory.legacy-aliases` remains runtime-compatible, but the
  flat `pinecone*` fields are scheduled for removal in v2.0.0. Use `memory.pinecone.*`
  and `npm run migrate-memory-config` for staged migrations.
- `env:access-control` (`ADMIN_PHONES`) remains supported for single-instance mode, but
  is scheduled for removal in v2.0.0. Use per-instance `adminPhones` in `config.json`.
- `artifact:fleet.token-legacy` (`<configRoot>/fleet-token`) remains readable for
  rollback, but is scheduled for removal in v2.0.0. Use `<configRoot>/fleet-tokens.json`.

## Validation

- Registry links and MCP module entries were checked against local markdown anchors,
  `src/mcp/tools/*.ts`, and `docs/tools.md` module counts.
- `guard:public-surface-drift` is wired into `verify:push:branch` and
  `verify:release` for the registry branch gate; `guard:doc-drift` and
  `guard:work-index` remain separate documentation/work-index gates.
