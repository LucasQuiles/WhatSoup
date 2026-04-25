# Blast Radius

Current verdict: Pass

## Allowed blast radius

New contract/test files only. No production runtime path imports them in PR 0a.

## Disallowed blast radius

Runtime, MCP, DB, fleet, deploy, logger, config, and real provider adapter behavior.

## Evidence

See `artifacts/blast_changed_files.txt` and `artifacts/blast_radius_hits.txt`.
