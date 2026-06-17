# Foundation Hardening — Probe Suite (design spec)

Date: 2026-06-15
Status: implemented (verified 2026-06-15)
Scope: `/Users/testuser/agent-runtime-probes/` — refactor + guard enhancement. No `AGENT-RUNTIME-*` reference-doc changes (lean ceiling = 13). `/Users/testuser` is not a git repo; artifacts are untracked working files.

## Goal

Single-home duplicated probe helpers into `probelib.py`, fix a latent bad-JSON handling
inconsistency, and add three `corpus_guard.py` checks that mechanize hygiene invariants
currently maintained by hand. Behavior-preserving except one consistency fix (D1).

Done = `corpus_guard.py` PASS + all probe tests green + `test-integrity` scan: no findings.
Verified implementation: 12 standalone probe tests passed, `corpus_guard.py` reported
`probe_count=17` / `script_count=16` with no violations, and `test-integrity` reported no
findings.

## Part 1 — probelib expansion (dedup)

`probelib.py` already hosts `redact`, `run`, `load_json`, `load_toml`, `du`, `sqlite_counts`.
Add and adopt:

1. **`git_head(repo: Path) -> str | None`** — extract the 4 byte-identical copies in
   `bot_errors_proof_ladder.py`, `q_namespace_lint.py`, `whatsoup_alias_map.py`,
   `whatsoup_spawn_config_probe.py`. Each probe imports it; local def deleted.
2. **`sha256_16(value: str) -> str`** — extract the 6 copies in `codex_hook_dual_path_probe.py`,
   `opencode_config_redactor.py`, `mcp_schema_inventory_probe.py`, `model_todo_provenance_probe.py`,
   `secret_guard_canary.py`, `tmup_dag_schema_probe.py`. (Confirm each local copy is the
   `sha256(...).hexdigest()[:16]` form before swapping; preserve exact output.)
3. **`run()` consolidation** — route the 3 local copies (`opencode_topology_export.py` t=30,
   `runtime_doctor.py` t=20, `pi_presence_probe.py` t=10) through `probelib.run`, **each call
   site passing its original timeout explicitly** (timeouts unchanged → behavior-preserving).
4. **`load_json()` consolidation** — route the 4 callers through `probelib.load_json`.

### Decision D1 (the one behavioral change)

`bot_errors_proof_ladder.py` and `whatsoup_alias_map.py` call `json.loads(path.read_text())`
with **no** try/except → they raise/crash on malformed JSON. Routing through
`probelib.load_json` makes them return a graceful `{"_error": "<type>: <msg>"}` marker.
**Before switching:** read each consumer of those calls and confirm it handles `_error`
(does not silently treat the marker as valid data — guard against masked failure). Add a
bad-JSON test proving the marker path (returns `_error`, does not raise). If a consumer
would mishandle `_error`, add an explicit `_error` check there as part of this change.

## Part 2 — corpus_guard checks (read-only, fail-closed)

Extend `check_probe_hygiene` (or add sibling checks):

- **P3 redaction_discipline (HIGH):** every non-library probe (`*.py` except `probelib.py`,
  `corpus_guard.py`) must declare a redaction posture — import `probelib.redact` **or**
  contain a `"redaction":` banner string. Flag any value-emitter with neither. *Honest scope:
  enforces declared posture, not proven non-leak.* Passes today (all 8 non-probelib probes
  carry banners); catches future drift. HIGH → fails the gate on violation.
- **P4 schema_version_consistency (MED):** every probe with a `SCHEMA_VERSION`/`schema_version`
  must have a value matching `^\d+\.\d+$`; flag missing/malformed.
- **P7 readme_drift (MED):** every probe (non-library) has a row in `README.md`'s script
  table, and every README script-table row resolves to an existing `*.py`. Flag both directions.

## Testing (TDD-first)

- `tests/test_probelib.py` (new): `git_head` (in/out of a repo), `sha256_16` (known vector,
  16 chars), `load_json` bad-JSON → returns `_error` (not raise), good-JSON → parsed.
- Every refactored probe's existing test stays green (behavior preserved). Run the full
  `tests/test_*.py` suite + `test-integrity scan tests/`.
- `corpus_guard`: extend its self-test or add fixtures proving P3 (probe w/ neither redact
  nor banner → flagged), P4 (malformed schema_version → flagged), P7 (probe missing README
  row → flagged; orphan README row → flagged). Confirm the guard still emits valid JSON and
  the three existing checks stay green.

## Out of scope (YAGNI)

P6 timeout-default change beyond explicit-pass routing; P8 dead/orphan-probe check; P9
unified runner; P10 beyond the `load_json` routing; any change to the 8 probes' internals
beyond helper extraction; any new top-level reference doc.

## Risks

- D1 consumer-semantics: a consumer mishandling the `_error` marker = masked failure. Mitigated
  by reading every consumer + the bad-JSON test.
- `sha256_16` extraction: a local copy that differs (e.g. different slice length) would change
  output. Mitigated by confirming each copy's form before swap + keeping per-probe tests green.
- P3/P4/P7 false positives would flip the gate to WARN/FAIL. Mitigated by running the guard
  after each check is added and confirming current suite passes.
