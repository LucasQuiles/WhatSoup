# Loop-Lag Safe Forensic Pipeline Design

**Status:** Approved with implementation conditions C1-C6
**Date:** 2026-08-15
**Issue:** #3253

## 1. Purpose

Build an end-to-end, content-free event-loop-lag evidence pipeline without
inflating the stable `/health` response or the fleet/console line payload. The
pipeline must preserve the sampler's starvation and discontinuity semantics,
give observations an exact wall-clock correlation point, and durably capture a
gap-aware stream suitable for testing competing starvation hypotheses.

## 2. Current Evidence and Constraints

- The watchdog rejects an authenticated diagnostic health body larger than
  65,536 bytes.
- The largest observed deployed agent diagnostic body was 48,639 bytes before raw
  loop-lag samples.
- A representative 160-sample raw array is approximately 20-26 KiB, depending
  on whether each record carries a wall-clock timestamp. Embedding it in
  `/health` crosses the watchdog limit on that deployed agent shape.
- The fleet server polls authenticated instance health every five seconds,
  stores the entire response in `InstanceStatus.health`, and forwards it via
  `/api/lines` and `/api/lines/:name`.
- The console polls those routes every five seconds when disconnected and every
  fifteen seconds while WebSocket-connected.
- The sampler uses a monotonic clock for lag math. Wall-clock time is required
  only for correlation with timestamped logs and must never participate in lag
  calculation.
- The health token must not appear in argv, stdout, logs, JSONL, or error text.
- The existing descriptor-safe token reader and private JSONL writer are the
  canonical file primitives:
  `readPrivateHealthTokenFileSync` and `appendPrivateJsonLineSync`.

## 3. Scope

This design has two independently testable stages that land together only after
each has its own verification receipts.

### Stage A: Safe producer endpoint

- Keep only bounded aggregate event-loop fields in authenticated `/health`.
- Expose raw samples through a dedicated authenticated endpoint.
- Give every raw sample a process-local sequence and both monotonic and wall
  observation timestamps.
- Preserve the fixed timer phase so request-time snapshots cannot manufacture
  a phantom interval stall.

### Stage B: Durable collector

- Poll the dedicated endpoint from the same host over loopback.
- Append versioned, content-free JSONL records through a private descriptor-safe
  writer.
- Deduplicate overlap, detect cursor eviction and process incarnation changes,
  and record poll gaps explicitly.
- Produce a bounded terminal summary and a nonzero exit for incomplete runs.

## 4. Non-Goals

- No provider, WhatsApp, database-schema, or fleet-control mutation.
- No GitHub issue automation or external publication.
- No raw samples in `/api/lines`, WebSocket events, or the browser console.
- No automatic diagnosis of the blocking operation; the collector records
  evidence for a later correlation analysis.
- No fleet-wide remote collector in this change. One collector observes one
  loopback instance.
- No change to the 250ms starvation threshold, 500ms cadence, 20-sample window,
  or greater-than-10-second discontinuity rule.

## 5. Stage A Architecture

### 5.1 Raw sample identity

`RawLoopLagSample` adds:

```ts
interface RawLoopLagSample {
  sequence: number;
  atMs: number;
  wallAtMs: number;
  lagMs: number;
  source: 'interval' | 'snapshot';
  discontinuity: boolean;
  eluUtilization: number | null;
  cpuDeltaMs: number | null;
}
```

`sequence` starts at 1 for each sampler construction and increases once per
accepted observation. The 360-entry in-memory ring remains oldest-first and
bounded. A sequence is never reused within one process incarnation, including
across `stop()`/`start()` on the same sampler.

Lag math uses the injected monotonic `now`. `wallAtMs` uses an injected wall
clock whose production default is `systemClock.now()`. The sampler advances the
original expected interval phase by the number of elapsed slots; it never
rebases the interval deadline to `actual + cadence`.

ELU and CPU readings are admitted only when their deltas are finite and
non-negative. ELU must also fall in `[0, 1]`. Invalid deltas serialize as `null`,
never as JSON's implicit conversion of `NaN` or Infinity.

### 5.2 Dedicated endpoint

Add:

```text
GET /health/event-loop-samples?after=<sequence>&limit=<count>
```

Contract:

- Requires the same scoped Bearer health authentication as privileged health
  diagnostics. Missing or invalid authentication returns `401`; it never falls
  back to the public liveness envelope.
- `after` is an optional non-negative safe integer. Only samples with
  `sequence > after` are returned.
- `limit` defaults to 160 and must be an integer from 1 through 160. Unknown,
  repeated, malformed, or out-of-range query parameters return `400` with a
  bounded error code.
- Without `after`, the endpoint returns the newest `limit` samples, ordered
  oldest-first.
- With `after`, it returns the oldest retained matching samples up to `limit`,
  ordered oldest-first.
- The endpoint is a snapshot, not long polling.
- Response size must stay below 32 KiB for the maximum 160 records. If the
  chosen object representation cannot meet that budget, use a versioned
  columnar representation or reduce the maximum; do not raise the budget
  silently.

Successful response:

```json
{
  "schema_version": "health.event-loop-samples.v1",
  "generated_at": "2026-08-15T00:00:00.000Z",
  "process": {
    "pid": 123,
    "started_at_ms": 1785000000000,
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "cadence_ms": 500,
  "oldest_sequence": 100,
  "latest_sequence": 459,
  "next_after": 259,
  "truncated": true,
  "gap": null,
  "samples": []
}
```

If `after` precedes the retained cursor, `gap` is:

```json
{
  "kind": "cursor_evicted",
  "after": 20,
  "first_available_sequence": 100
}
```

The endpoint still returns the available samples. `next_after` is the final
returned sequence, or the input cursor when no sample is returned.

### 5.3 `/health` compatibility

Authenticated `/health` retains existing aggregate event-loop fields and adds
only small discovery metadata:

```json
{
  "raw_samples": {
    "available": true,
    "schema_version": "health.event-loop-samples.v1",
    "path": "/health/event-loop-samples",
    "oldest_sequence": 100,
    "latest_sequence": 459
  }
}
```

It does not contain `raw_recent`. The unauthenticated four-key public envelope
is byte-for-byte unchanged. The fleet poller and console therefore continue to
carry aggregates without the raw ring.

## 6. Stage B Collector Architecture

### 6.1 CLI surface

Create `scripts/collect-loop-lag-samples.ts` with two commands:

```text
collect-loop-lag-samples schema
collect-loop-lag-samples collect --instance <name> --base-url <url>
  --token-file <absolute-path> --output <absolute-path>
  [--once | --interval-ms <1000..300000> --duration-ms <positive>]
  [--limit <1..160>] [--max-output-bytes <positive>]
  [--format json]
```

Rules:

- `schema` requires no credentials or network and emits the compact command,
  input, output, effect, and exit-code schemas.
- Output mode is explicit and TTY-independent. `--format json` emits exactly one
  schema-valid summary object on stdout; progress and diagnostics go to stderr.
- `collect` accepts only loopback HTTP origins (`127.0.0.1`, `[::1]`, or
  `localhost`). Redirects are disabled.
- The token is read only from `--token-file` through
  `readPrivateHealthTokenFileSync`. No literal token flag or environment
  fallback exists.
- `--once` and interval/duration mode are mutually exclusive. Without `--once`,
  both interval and duration are required.
- The command is network-read-only but appends to one named local artifact.
  Machine-readable effect metadata reports:

```json
{
  "network_effect": "read_only_loopback",
  "filesystem_effect": "append_private_artifact",
  "destructive": false,
  "idempotent_samples": true,
  "supports_dry_run": false
}
```

### 6.2 JSONL record contract

The output file is created mode `0600`, refuses symlinks and unsafe ownership,
and is appended through `appendPrivateJsonLineSync`. It is capped by
`--max-output-bytes`, default 50 MiB, using an existing bounded JSONL retention
pattern that preserves whole records.

Every line has `schema_version: 1`, `record_type`, `run_id`, `observed_at`,
`instance`, and a bounded payload. Record types:

- `run_started`: validated configuration excluding token/path secrets.
- `sample`: process identity plus one raw sample.
- `gap`: `cursor_evicted`, `process_changed`, or `poll_interval_missed`.
- `poll_error`: stable `kind`, HTTP status when present, `retryable`, and count;
  never response bodies or exception prose.
- `run_completed`: terminal counts, first/last sequence, gap counts, successful
  poll count, failed poll count, and final outcome.

Sample dedupe key:

```text
(instance, process.started_at_ms, process.pid, sample.sequence)
```

Within one run the collector maintains this key in bounded memory. Across runs,
it reads only a bounded tail sufficient to recover the last terminal cursor. An
unreadable, malformed, or unsupported prior tail fails closed instead of
starting from an assumed cursor.

### 6.3 Poll and failure semantics

- Each request has a five-second timeout.
- HTTP `401` is terminal `authentication_failed`.
- HTTP `404` or a wrong response schema is terminal `endpoint_unsupported`.
- Timeout, connection refusal, and HTTP `5xx` are retryable during an interval
  run and produce `poll_error` records.
- A changed process identity produces `gap(process_changed)`, resets the cursor,
  and continues from the new ring.
- Cursor eviction produces `gap(cursor_evicted)` and continues with retained
  data; the run remains `partial`.
- A scheduled poll that begins after the next interval boundary records
  `gap(poll_interval_missed)` rather than pretending continuous observation.
- Every run attempts to write `run_completed`. If the output writer itself
  fails, stderr reports a bounded error and the process exits nonzero; no stdout
  success summary is emitted.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | complete run; at least one successful poll; no evidence gaps |
| 1 | partial run; samples captured but one or more explicit gaps/errors |
| 2 | invalid invocation or unsafe path/configuration |
| 3 | authentication failed |
| 4 | endpoint unsupported or schema incompatible |
| 5 | no successful poll before duration ended |
| 6 | private output artifact could not be created/appended/finalized |

## 7. Data Flow

```text
LoopLagSampler (bounded ring)
  ├─ aggregate snapshot ──> authenticated /health ──> watchdog/fleet/console
  └─ cursor page ─────────> /health/event-loop-samples
                               └─ loopback collector
                                    └─ private bounded JSONL
                                         └─ later correlation analysis
```

The watchdog, fleet poller, and browser never consume raw samples. The
collector is the sole durable raw consumer in this design.

## 8. Security and Privacy

- All evidence is content-free: timestamps, counters, bounded enums, process
  identity, release commit, and numeric resource deltas only.
- Raw samples are privileged and never present in unauthenticated health.
- Token material is descriptor-read, never serialized, and cleared from local
  variables after request construction where practical.
- Loopback-only URL validation prevents turning the collector into a generic
  credential-bearing HTTP client.
- Redirects are refused so the Authorization header cannot cross origins.
- Output paths are explicit absolute paths, private, non-symlink, and bounded.
- Errors use stable codes; response bodies, filesystem paths, tokens, and raw
  exception prose do not enter JSONL.

## 9. Testing Requirements

### Sampler

- Timer-phase regression goes red under `actual + cadence` rebasing.
- Wall-clock jumps do not alter lag math.
- Sequence is monotonic across window reset and sampler stop/start.
- Ring eviction preserves sequence order.
- Negative/non-finite ELU and CPU deltas become `null`.

### Endpoint

- Missing/invalid token is `401` with no raw bytes.
- Public `/health` remains the exact four-key envelope.
- `/health` contains no `raw_recent` and remains below the watchdog limit using
  a representative maximum diagnostic fixture.
- Cursor, limit, ordering, truncation, and eviction-gap behavior are exact.
- Duplicate/unknown query parameters fail closed.
- Maximum endpoint response is below 32 KiB.

### Downstream regression

- Fleet `InstanceStatus.health` and `/api/lines` contain aggregates and endpoint
  discovery metadata but no sample array.
- Console line payload fixtures do not grow with the raw ring.
- Rendered watchdog tests accept the aggregate health response and preserve the
  65,536-byte guard.

### Collector

- Schema command works offline.
- Unsafe token/output files and non-loopback URLs fail before network access.
- Token never appears in argv-derived output, stdout, stderr, or JSONL.
- Overlap deduplicates; cursor eviction and process change produce gaps.
- Poll failure/recovery, duration exhaustion, and writer failure produce the
  specified terminal records and exit codes.
- Bounded retention preserves valid whole JSONL records.
- A simulated 9-second observation delay retains the exact causal sample and
  correlates through `wall_at_ms`.

## 10. Documentation and Operational Rollout

Update:

- `docs/public-surface.md` with both authenticated endpoint contracts.
- `docs/runbooks/macos-launchd-deployment.md` with watchdog-size verification.
- A focused collector runbook with safe invocation, evidence interpretation,
  retention, restart/gap semantics, and cleanup.
- `package.json` with pinned-node scripts for schema, one-shot probe, focused
  tests, and collector invocation.

Rollout order:

1. Run exact-head focused, watchdog, fleet/console, ratchet, typecheck, build,
   full battery, and coverage gates.
2. Open a normal PR and require CI on the exact pushed head.
3. Cut a canary only after merge.
4. Rehearse collector capture against a local test server.
5. Deploy to the canary host with the established quiesce, byte-exact backup, repoint,
   and rollback sequence.
6. Prove authenticated `/health` remains below 65,536 bytes before restoring
   automated supervision.
7. Run the collector through real traffic and require at least one real served
   turn before interpreting the evidence or cleaning old releases/backups.

## 11. Acceptance Criteria

- The maximum supported authenticated agent `/health` fixture remains below the watchdog limit
  with documented safety margin and contains no raw sample array.
- Raw endpoint maximum response remains below 32 KiB and is authenticated,
  cursor-addressable, versioned, bounded, and content-free.
- Timer phase, wall correlation, sample sequence, invalid resource counters,
  and process changes have deterministic falsifiers.
- The collector produces a private, bounded, gap-aware JSONL stream and never
  exposes its token.
- Fleet and console general-purpose payloads do not carry raw samples.
- No existing starvation, discontinuity, authentication, watchdog, or public
  health behavior regresses.
- Full verification and CI pass on the exact final head; masked or interrupted
  checks remain explicitly inconclusive.

## 12. Approved Conditions

- **C1:** The production wall clock defaults to `systemClock.now()`; the clock-budget ratchet is required.
- **C2:** An empty page with no cursor returns `next_after: 0`; with a cursor it preserves that cursor.
- **C3:** Page samples and cursor metadata derive from one immutable ring copy.
- **C4:** The physical ring spans about 180 seconds, but the supported gap-free interval ceiling is 150 seconds. Larger configured intervals are documented as gap-guaranteed by the operating contract because the final margin belongs to jitter, request latency, and page draining.
- **C5:** The raw-sampling producer commit must not merge or deploy with `raw_recent` still embedded in `/health`; endpoint extraction and aggregate-only health land in the same PR.
- **C6:** Rollout verification names all six file-scope ratchets explicitly: `clock-budget`, `env-read-allowlist`, `secret-env-read-guard`, `fitness-file-size-warning-budget`, `fitness-sync-exec-timeout-budget`, and `public-surface-drift-check`.
