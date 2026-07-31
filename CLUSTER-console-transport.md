# draft(cluster): console/transport surface gaps (4 P3-P4 issues)

Closes #2550, #2135, #2121, #2085

Console: mark-read remote outcome reaches the API and is then discarded (#2550, P4). Bound high-cadence BOT ERRORS controller diagnostics and JSONL retention (#2135, P3). Post-handoff session fails to rehydrate from transport + brittle recovery (#2121, P3). ci-control-result.test.ts: two unpinned clock-taking validator calls (#2085, P3).

All guards pass.
