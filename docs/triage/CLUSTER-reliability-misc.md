# draft(cluster): reliability misc — dispatcher, registration, portability (7 P2-P4 issues)

> **Triage catalog — not a closure record, and not a PR body.**
> Authored as `draft(cluster)` PR bodies (#2763–#2781; all closed, **none merged**) and
> committed verbatim by #2787 for their grouping and per-issue summaries. `Tracks #N` is a
> reference, never a closing directive — the original `Closes` keyword bound only to the
> issue immediately after it and asserted closure of work that is largely still open. The
> original `All guards pass` line has been removed: no per-issue verification stands behind
> it. Read the issues for real status.

Tracks #2281, #2279, #2634, #2629, #2363, #2548, #2454

Fence queued incident delivery by durable episode state (#2281, P2). Wire registration write-path + delivery daemon (#2279, P3). Non-portable shell shebangs and ps flags in deploy scripts (#2634, P3). 10+ fetch() calls lack AbortSignal.timeout() (#2629, P2). Remove fixed-time child PID race from new-command ownership coverage (#2363, P3). Replay: access approval reports success after queued-message replay error (#2548, P4). Guard sweep: no other node-to-shell integer captures are vulnerable (#2454, P3).
