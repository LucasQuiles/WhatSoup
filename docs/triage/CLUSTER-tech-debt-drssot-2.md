# draft(cluster): tech-debt DRY/SSOT — guard designs, helpers, type unions (7 P3 issues)

> **Triage catalog — not a closure record, and not a PR body.**
> Authored as `draft(cluster)` PR bodies (#2763–#2781; all closed, **none merged**) and
> committed verbatim by #2787 for their grouping and per-issue summaries. `Tracks #N` is a
> reference, never a closing directive — the original `Closes` keyword bound only to the
> issue immediately after it and asserted closure of work that is largely still open. The
> original `All guards pass` line has been removed: no per-issue verification stands behind
> it. Read the issues for real status.

Tracks #2240, #2241, #2242, #2244, #2245, #2203, #2204

56 duplicate helper definitions in fleet HTTP route tests (#2240). Transport adapter reason codes not a canonical union (#2241). Duplicate nowUnixSec/normalizeUnixTimestampSeconds (#2242). InboundStatus union is a loose string union (#2244). ProviderParityProbeState is a loose object (#2245). 4 hand-rolled shape guards bypass Zod mandate (#2203). 5 inline XDG_*_HOME reads bypass xdgDir() helper (#2204).
