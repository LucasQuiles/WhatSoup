# 2026-07-14 Database Compatibility Drain

## Summary

WhatSoup now refuses writable startup when the database is from a newer binary,
requires SQLite recovery, has an invalid schema, or fails its path-identity and
ownership checks. Drainable incompatibilities keep a bounded, content-free health
surface available for operators without starting WhatsApp, provider sessions, or the
agent runtime.

## Public Surface Additions

- `GET /health` can return `503` from an inspection-only startup process with
  `service_mode: "inspection_only"`, a content-free `startup_block`, database
  compatibility metadata, and provider and synthetic admission marked `blocked`.
- The inspection-only process exposes no mutation endpoints. Non-health requests
  return a content-free `INSPECTION_ONLY` error response. It binds only to
  `127.0.0.1` on the instance's configured `healthPort`, or `9090` when absent.
- Every running runtime reports a schema newer than the binary as unhealthy with
  `schema_ready: false`; authenticated normal-runtime mutation endpoints are
  otherwise unchanged. A running Chat process that observes compatibility loss also
  returns only
  `runtime.chat.database_compatibility.reason`, `observed_migration`, and
  `required_migration`; paths, JIDs, and message content are excluded.

## Operator Impact

- A compatibility drain is not a healthy WhatsApp runtime and must not be treated as
  one by fleet health or watchdog logic.
- A running Chat process that latches compatibility loss from its queue or a guarded
  background provider stops enrichment and memory consolidation, and an in-flight
  enrichment poller performs no post-provider writes. It rejects later admissions
  and does not try to terminalize the affected inbound through the read-only fence;
  the compatible-binary recovery path retains ownership.
- The launchd health watchdog can perform one transition restart into inspection-only
  startup. systemd `Restart=on-failure` does not react to HTTP `503`; on systemd, a
  controlled operator restart is required.
- Supported drain reasons remain observable so operators can choose the matching
  backup, upgrade, or SQLite recovery procedure without opening the database for
  writes.
- Older binaries must not be used as rollback targets after a newer schema writer has
  advanced the database.

## Validation

- Schema-ceiling and database-identity tests exercise the pre-write rejection path.
- Health protocol tests pin the inspection-only response shape and fail-closed
  watchdog classification.
- Public-surface drift tests require both health implementations and the inspection
  contract to remain registered.
