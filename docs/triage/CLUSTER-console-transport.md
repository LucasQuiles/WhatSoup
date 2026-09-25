# draft(cluster): console/transport surface gaps (4 P3-P4 issues)

> **Triage catalog — not a closure record, and not a PR body.**
> Authored as `draft(cluster)` PR bodies (#2763–#2781; all closed, **none merged**) and
> committed verbatim by #2787 for their grouping and per-issue summaries. `Tracks #N` is a
> reference, never a closing directive — the original `Closes` keyword bound only to the
> issue immediately after it and asserted closure of work that is largely still open. The
> original `All guards pass` line has been removed: no per-issue verification stands behind
> it. Read the issues for real status.

Tracks #2550, #2135, #2121, #2085

Console: mark-read remote outcome reaches the API and is then discarded (#2550, P4). Bound high-cadence BOT ERRORS controller diagnostics and JSONL retention (#2135, P3). Post-handoff session fails to rehydrate from transport + brittle recovery (#2121, P3). ci-control-result.test.ts: two unpinned clock-taking validator calls (#2085, P3).
