# Loop-Lag Safe Forensic Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox form so the implementation receipt can name the exact completed and deferred work.

**Goal:** Replace the oversized in-band raw loop-lag health payload with a bounded authenticated cursor endpoint and a private, gap-aware loopback collector while preserving timer-phase, health-authentication, public-envelope, watchdog, fleet, and console behavior.

**Architecture:** `LoopLagSampler` remains the sole producer and owns sequence allocation plus a bounded ring. A pure cursor projection copies that ring once per request, and `startHealthServer` exposes the projection only through a scoped-authenticated endpoint while `/health` retains aggregates and small discovery metadata. A separate CLI polls only loopback, validates the versioned endpoint response, and appends whole private JSONL records through the repository's descriptor-safe filesystem primitives.

**Tech Stack:** TypeScript, Node.js 24.15.0, Vitest, Node HTTP, Zod where runtime decoding is required, existing `systemClock`, `readPrivateHealthTokenFileSync`, `appendPrivateJsonLineSync`, and repository publication/work-index guards.

## Global Constraints

- Work from `fix/loop-lag-safe-forensic-pipeline`, which is stacked on the timer-phase fix and raw-sampling producer history. Do not merge or deploy `758dcba27` or any descendant that still exposes `raw_recent` through `/health` without the dedicated endpoint correction in the same reviewed PR.
- Preserve the 500ms cadence, 20-sample aggregate window, 250ms starvation threshold, 10-second discontinuity threshold, and 360-record raw ring.
- Use the monotonic injected `now` only for lag arithmetic. Use the injected `wallNow`, defaulted to `systemClock.now()`, only for wall correlation.
- Keep the unauthenticated `/health` response exactly four keys. Missing or invalid authentication on `/health/event-loop-samples` returns `401`; it never degrades to the public envelope.
- Keep authenticated `/health` below the watchdog's 65,536-byte ceiling with a measured fixture margin. Keep the maximum raw endpoint body below 32 KiB.
- Collector tokens must never enter argv values, environment fallbacks, stdout, stderr, JSONL, response-derived errors, or redirect requests.
- All test commands run with `$HOME/.nvm/versions/node/v24.15.0/bin` first in `PATH`. A masked, interrupted, timed-out, or partially inspected run is inconclusive.
- No push, PR creation, merge, CI retry, deployment, service restart, or remote-host mutation is part of Tasks 1-8. Those remain explicit publication and operational gates after local completion.

---

## Task 1: Correct and harden raw sample production

**Files:**

- Modify: `src/lib/loop-lag-sampler.ts`
- Modify: `tests/lib/loop-lag-sampler.test.ts`
- Verify: `tests/scripts/clock-budget.test.ts`

- [ ] **Step 1: Add failing sequence, clock, and invalid-reading tests**

Add tests that prove:

1. the first accepted observation has `sequence: 1`;
2. sequence increases across aggregate-window reset, raw-ring eviction, and `stop()`/`start()` on the same sampler;
3. a new sampler starts again at 1;
4. an injected wall-clock jump changes only `wallAtMs`, never `lagMs`;
5. negative or non-finite ELU/CPU deltas become `null`;
6. ELU outside `[0, 1]` becomes `null`;
7. the timer-phase falsifier remains red if the deadline is changed back to `actualAtMs + LOOP_LAG_SAMPLE_INTERVAL_MS`.

Use deterministic injected monotonic and wall clocks; do not use real timers for sequence or delta assertions.

- [ ] **Step 2: Run the sampler test and observe RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/lib/loop-lag-sampler.test.ts
```

Expected: new sequence assertions fail because `RawLoopLagSample` has no sequence, and the invalid-delta cases expose the current unbounded arithmetic.

- [ ] **Step 3: Implement sequence allocation and safe production defaults**

In `src/lib/loop-lag-sampler.ts`:

```ts
import { systemClock } from './clock.ts';

export interface RawLoopLagSample {
  readonly sequence: number;
  // existing fields remain unchanged
}

private nextRawSequence = 1;

constructor(options: LoopLagSamplerOptions = {}) {
  this.now = options.now ?? (() => performance.now());
  this.wallNow = options.wallNow ?? (() => systemClock.now());
  // existing readers remain
}
```

Allocate the sequence only after an observation has passed the early-return guard, immediately before it enters the ring. Increment with a fail-closed safe-integer guard; exhausting `Number.MAX_SAFE_INTEGER` must throw instead of reusing a cursor.

Validate derived counters before storing them:

```ts
function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function validElu(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
```

Do not reset `nextRawSequence` in `resetWindow()`, `stop()`, or `start()`.

- [ ] **Step 4: Run focused GREEN plus the clock ratchet**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/lib/loop-lag-sampler.test.ts tests/scripts/clock-budget.test.ts
```

Expected: both files pass, including the timer-phase mutation detector and the `systemClock.now()` convention.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/loop-lag-sampler.ts tests/lib/loop-lag-sampler.test.ts
git diff --cached --check
git commit -m "fix(health): harden raw loop-lag sample identity"
```

---

## Task 2: Add immutable, exact cursor pagination

**Files:**

- Modify: `src/lib/loop-lag-sampler.ts`
- Modify: `tests/lib/loop-lag-sampler.test.ts`

- [ ] **Step 1: Add the cursor-page contract tests**

Define tests for `rawSamplePage({ after, limit })` that pin:

- empty ring with no cursor: `nextAfter === 0`, null oldest/latest, no gap, not truncated;
- empty ring with `after: 41`: `nextAfter === 41`;
- no cursor on a non-empty ring: newest `limit`, returned oldest-first;
- cursor present: oldest retained records with `sequence > after`;
- `nextAfter`: final returned sequence, otherwise the supplied cursor, otherwise 0;
- truncation when eligible records exceed `limit`;
- eviction gap only when `after < oldestSequence - 1`;
- no false gap when `after === oldestSequence - 1`;
- returned sample and metadata remain stable if a test-only hook appends to the live ring after the page method copies it.

The last case is the C3 race falsifier: pagination must calculate metadata and rows from one immutable `const ring = [...this.rawRing]` copy.

- [ ] **Step 2: Run the pagination tests and observe RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/lib/loop-lag-sampler.test.ts -t "raw sample page"
```

Expected: RED because `rawSamplePage` does not exist.

- [ ] **Step 3: Implement the page type and one-copy algorithm**

Add exported contracts:

```ts
export interface RawLoopLagSampleGap {
  readonly kind: 'cursor_evicted';
  readonly after: number;
  readonly firstAvailableSequence: number;
}

export interface RawLoopLagSamplePage {
  readonly oldestSequence: number | null;
  readonly latestSequence: number | null;
  readonly nextAfter: number;
  readonly truncated: boolean;
  readonly gap: RawLoopLagSampleGap | null;
  readonly samples: readonly RawLoopLagSample[];
}
```

`rawSamplePage` must validate `after` as a non-negative safe integer and `limit` as an integer in `1..160`, copy the ring once, and derive every field from that copy. Return copied sample objects or frozen read-only projections so a caller cannot mutate ring state.

- [ ] **Step 4: Run all sampler tests GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/lib/loop-lag-sampler.test.ts
```

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/loop-lag-sampler.ts tests/lib/loop-lag-sampler.test.ts
git diff --cached --check
git commit -m "feat(health): add immutable loop-lag cursor pages"
```

---

## Task 3: Build the bounded endpoint projection

**Files:**

- Create: `src/core/loop-lag-samples-endpoint.ts`
- Create: `tests/core/loop-lag-samples-endpoint.test.ts`
- Modify: `src/core/health.ts`
- Modify: `tests/core/health.test.ts`

- [ ] **Step 1: Write pure parser and response-budget tests**

In the new endpoint test file, pin:

- only `after` and `limit` are accepted;
- repeated, empty, signed, decimal, exponential, whitespace, unsafe-integer, and out-of-range values return a bounded stable `400` code;
- default limit is 160;
- maximum records serialize below `32 * 1024` bytes using maximum safe sequence/timestamp values and representative maximum finite metric values;
- no serialized field is `NaN`, `Infinity`, or an unbounded exception string;
- generated response keys and `schema_version` are exact;
- the empty/no-cursor response has `next_after: 0`;
- endpoint samples use snake_case and bounded numeric precision while retaining millisecond correlation accuracy.

Define the leaf interface before production wiring:

```ts
export const LOOP_LAG_SAMPLES_SCHEMA_VERSION = 'health.event-loop-samples.v1';
export const LOOP_LAG_SAMPLES_MAX_LIMIT = 160;
export const LOOP_LAG_SAMPLES_MAX_RESPONSE_BYTES = 32 * 1024;

export interface LoopLagSamplesProcessIdentity {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly commit: string;
}
```

- [ ] **Step 2: Run the leaf test and observe RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/core/loop-lag-samples-endpoint.test.ts
```

Expected: RED because the endpoint module does not exist.

- [ ] **Step 3: Implement pure query parsing and response projection**

Export pure functions that return discriminated results rather than writing HTTP directly:

```ts
type QueryResult =
  | { ok: true; after?: number; limit: number }
  | { ok: false; status: 400; code: LoopLagQueryErrorCode };

export function parseLoopLagSamplesQuery(url: URL): QueryResult;
export function buildLoopLagSamplesResponse(input: {
  generatedAt: string;
  process: LoopLagSamplesProcessIdentity;
  cadenceMs: number;
  page: RawLoopLagSamplePage;
}): LoopLagSamplesResponse;
```

Round only the transport projection, not sampler storage: timestamps and lag to three decimal places, ELU to six, and CPU milliseconds to three. Assert the serialized maximum in tests; do not silently truncate a requested page at runtime. If the object projection cannot prove the 32 KiB maximum, change the endpoint response to a documented columnar `samples` representation in this task and update both producer and collector contracts together.

- [ ] **Step 4: Add authenticated route integration tests**

In `tests/core/health.test.ts`, add tests proving:

- missing and invalid Bearer tokens on `/health/event-loop-samples` return `401` and no sample fields;
- a valid server-scoped token returns the exact versioned page;
- auth resolution uses the same per-server cached `HealthAuthState` as mutation routes and privileged `/health`;
- unknown/repeated query parameters return bounded `400` JSON;
- non-GET methods and near-match paths return `404`;
- response `process.started_at_ms` comes from `deps.startedAt`, `pid` from the live process dependency/constant, and commit from the same release identity used by health;
- a test sampler mutation after page-copy cannot mix cursor metadata with later records.

- [ ] **Step 5: Wire the route before the `/health` fallback**

In `startHealthServer`, parse the pathname without allowing a crafted query to bypass route identity. For the exact GET endpoint:

1. call `requireAuth(req, res, healthAuth)`;
2. parse query with the pure parser;
3. get exactly one `rawSamplePage`;
4. construct the versioned response;
5. serialize once, assert the tested fixed budget defensively, and return JSON.

The route must not call `snapshot()`, because polling forensic samples must not create a new observation.

- [ ] **Step 6: Run endpoint and health suites GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run \
    tests/core/loop-lag-samples-endpoint.test.ts \
    tests/core/health.test.ts
```

- [ ] **Step 7: Commit Task 3**

```bash
git add \
  src/core/loop-lag-samples-endpoint.ts \
  src/core/health.ts \
  tests/core/loop-lag-samples-endpoint.test.ts \
  tests/core/health.test.ts
git diff --cached --check
git commit -m "feat(health): expose bounded loop-lag sample pages"
```

---

## Task 4: Remove in-band raw data and prove downstream compatibility

**Files:**

- Modify: `src/core/health.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/fleet/health-poller.test.ts`
- Modify: `tests/fleet/routes/lines.test.ts`
- Modify: `tests/deploy/watchdog-credential-dead.test.ts`
- Modify only if typed fixtures require it: `console/src/types.ts`
- Modify only if typed fixtures require it: relevant `tests/console/*.test.tsx`

- [ ] **Step 1: Add regression tests before removing `raw_recent`**

Pin these contracts:

- authenticated `/health.event_loop` has no `raw_recent` key;
- it includes only `raw_samples: { available, schema_version, path, oldest_sequence, latest_sequence }`;
- the unauthenticated public response remains exactly `schema_version`, `status`, `generated_at`, and `startupNotification`;
- a worst representative authenticated health fixture is below 65,536 bytes and records the actual margin in the assertion message;
- fleet `InstanceStatus.health`, `/api/lines`, WebSocket line payload fixtures, and console fixtures contain no `samples` or `raw_recent` array;
- rendered watchdog behavior still accepts the representative aggregate body and rejects a body above 65,536 bytes.

- [ ] **Step 2: Run the compatibility slice and observe RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run \
    tests/core/health.test.ts \
    tests/fleet/health-poller.test.ts \
    tests/fleet/routes/lines.test.ts \
    tests/deploy/watchdog-credential-dead.test.ts
```

Expected: at least the `raw_recent` absence and discovery-metadata assertions fail.

- [ ] **Step 3: Replace `raw_recent` with discovery metadata**

Use one immutable sampler page with `limit: 1` only if it can return oldest/latest without changing sampling. Prefer a dedicated `rawSampleBounds()` that copies the ring once if calling `rawSamplePage` would produce misleading truncation work. The aggregate response must not serialize any sample object.

Update the starvation log prose so it directs operators to the authenticated endpoint; do not claim the warning timestamp is the causal timestamp.

- [ ] **Step 4: Run downstream GREEN and measure both budgets**

Run the Step 2 command again, then add a direct test report or assertion for:

```text
authenticated_health_bytes < 65536
max_endpoint_bytes < 32768
```

This is the implementation proof for C5: a branch containing the raw producer cannot be publishable while `raw_recent` remains in `/health`.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/core/health.ts tests/core/health.test.ts \
  tests/fleet/health-poller.test.ts tests/fleet/routes/lines.test.ts \
  tests/deploy/watchdog-credential-dead.test.ts
git diff -- console/src/types.ts tests/console
# If and only if the preceding diff names intentional fixture/type changes:
git add console/src/types.ts tests/console
git diff --cached --check
git commit -m "fix(health): keep raw loop-lag samples out of line payloads"
```

Before committing, inspect `git diff --cached --name-only`; unmodified optional paths must not be staged, and unrelated console files must not enter the commit.

---

## Task 5: Implement the collector state machine as a testable library

**Files:**

- Create: `scripts/lib/loop-lag-collector.ts`
- Create: `tests/scripts/loop-lag-collector.test.ts`
- Reuse: `src/fleet/health-token-file.ts`
- Reuse: `src/lib/clock.ts`

- [ ] **Step 1: Add parser, security, and state-transition tests**

Tests must prove:

- only `http://127.0.0.1`, `http://[::1]`, and `http://localhost` origins are accepted, with no credentials, fragments, non-root path prefix, or non-loopback resolution;
- redirect mode is `error` and an endpoint redirect never receives a second request;
- token-file and output paths are absolute, distinct, and validated before network access;
- token comes only from `readPrivateHealthTokenFileSync` and never appears in returned errors;
- endpoint response schema is exact enough to reject a wrong version, malformed process identity, unsafe sequence, out-of-order samples, or body over 32 KiB;
- overlapping pages dedupe by `(instance, started_at_ms, pid, sequence)`;
- process identity change emits one `process_changed` gap, resets the cursor, and admits the new incarnation;
- `cursor_evicted` and `poll_interval_missed` are each emitted once per detected gap;
- timeout, refusal, and `5xx` are retryable; `401` and incompatible `404` are terminal;
- the captured 9-second-late observation remains attributable by `wall_at_ms` even though the warning arrived later.

- [ ] **Step 2: Run the collector library test and observe RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/scripts/loop-lag-collector.test.ts
```

- [ ] **Step 3: Implement exported pure and injected-I/O boundaries**

Keep CLI parsing out of this module. Export:

```ts
export function validateLoopbackBaseUrl(value: string): URL;
export function decodeLoopLagSamplesResponse(value: unknown): LoopLagSamplesResponse;
export function advanceCollectorState(
  state: CollectorState,
  response: LoopLagSamplesResponse,
  observedAt: string,
): CollectorTransition;
export async function fetchLoopLagSamplePage(
  input: FetchPageInput,
  deps: { fetch: typeof fetch; readToken: typeof readPrivateHealthTokenFileSync },
): Promise<FetchPageResult>;
```

The state transition returns records to append and the next state; it does not write files. Bound all in-run dedupe memory to the endpoint/ring horizon plus a small process-transition allowance. Use a five-second `AbortSignal.timeout` or injected equivalent.

- [ ] **Step 4: Run collector library GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/scripts/loop-lag-collector.test.ts
```

- [ ] **Step 5: Commit Task 5**

```bash
git add scripts/lib/loop-lag-collector.ts tests/scripts/loop-lag-collector.test.ts
git diff --cached --check
git commit -m "feat(ops): add loop-lag collector state machine"
```

---

## Task 6: Add private bounded JSONL retention and the agent-safe CLI

**Files:**

- Create: `scripts/collect-loop-lag-samples.ts`
- Create: `tests/scripts/collect-loop-lag-samples.test.ts`
- Modify: `scripts/lib/loop-lag-collector.ts`
- Modify only for a reusable primitive: `src/lib/private-fs.ts`
- Modify only for a reusable primitive: `tests/lib/private-fs.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write RED tests for artifact durability and CLI contracts**

Pin:

- `schema` is offline and emits exactly one JSON document containing commands, inputs, record schemas, effect metadata, and exit codes;
- `collect` rejects unknown/repeated flags and requires `--format json`;
- `--once` is mutually exclusive with interval/duration, while interval mode requires both;
- interval range is `1000..300000`; document in help that intervals above 150,000ms are operationally classified as gap-guaranteed because the supported capture contract reserves the final ~30 seconds of the 360-record/~180-second ring for timer jitter, request latency, and page draining;
- output parent becomes `0700`, file becomes `0600`, symlink/non-regular/foreign-owned paths fail closed;
- every append goes through `appendPrivateJsonLineSync` or a new primitive that preserves all its descriptor and fsync guarantees;
- retention at the default 50 MiB and an injected tiny limit keeps whole valid JSONL records, never partial bytes;
- a bounded valid tail recovers the last terminal process/cursor; malformed, unreadable, or unsupported tail fails before network access;
- token text is absent from stdout, stderr, JSONL, run records, and errors;
- exactly one JSON summary is printed on stdout for a completed invocation;
- exit codes are exactly 0 complete, 1 partial, 2 invocation/path, 3 auth, 4 unsupported, 5 no successful poll, 6 output failure;
- `run_completed` is attempted on every terminal path after `run_started`, while an output-writer failure emits no success summary.

- [ ] **Step 2: Run CLI tests and observe RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run tests/scripts/collect-loop-lag-samples.test.ts
```

- [ ] **Step 3: Implement whole-record bounded retention**

Do not truncate an open append descriptor. When the next serialized record would exceed the cap:

1. read a bounded tail no larger than the configured cap plus one record ceiling;
2. split only on newline boundaries;
3. validate every retained line as a supported collector record;
4. select the newest whole records that leave room for the new line;
5. publish the retained records to a mode-0600 sibling temp file using existing private-file protections;
6. fsync and rename atomically;
7. append the new record through the descriptor-safe path.

If the repository's private file helpers cannot express this without weakening ownership or symlink checks, add a focused `rewritePrivateJsonLinesSync` primitive beside `appendPrivateJsonLineSync` with direct unit tests. Do not implement retention with shell commands.

- [ ] **Step 4: Implement the CLI main boundary**

The CLI should expose a testable `run(argv, deps): Promise<number>` and a minimal main-module gate. Use `systemClock` for generated timestamps, `crypto.randomUUID()` for `run_id`, stable bounded error codes, and `process.exitCode = await run(...)`.

Add package scripts using the pinned runner:

```json
{
  "loop-lag-samples": "bash scripts/run-with-pinned-node.sh scripts/collect-loop-lag-samples.ts",
  "loop-lag-samples:schema": "npm run loop-lag-samples -- schema --format json",
  "test:loop-lag-forensics": "vitest run tests/lib/loop-lag-sampler.test.ts tests/core/loop-lag-samples-endpoint.test.ts tests/core/health.test.ts tests/scripts/loop-lag-collector.test.ts tests/scripts/collect-loop-lag-samples.test.ts"
}
```

- [ ] **Step 5: Run CLI and private-filesystem GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npx vitest run \
    tests/scripts/collect-loop-lag-samples.test.ts \
    tests/scripts/loop-lag-collector.test.ts \
    tests/lib/private-fs.test.ts

PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  npm --silent run loop-lag-samples:schema >/tmp/whatsoup-loop-lag-schema.json
node -e 'const x=require("/tmp/whatsoup-loop-lag-schema.json"); if (!x.effects || !x.exit_codes) process.exit(1)'
```

- [ ] **Step 6: Commit Task 6**

```bash
git add scripts/collect-loop-lag-samples.ts scripts/lib/loop-lag-collector.ts \
  tests/scripts/collect-loop-lag-samples.test.ts tests/scripts/loop-lag-collector.test.ts \
  src/lib/private-fs.ts tests/lib/private-fs.test.ts package.json
git diff --cached --check
git commit -m "feat(ops): collect private loop-lag evidence"
```

Inspect the staged name list and omit unchanged optional private-filesystem files.

---

## Task 7: Align documentation, public-surface declarations, and operations

**Files:**

- Modify: `docs/public-surface.md`
- Modify: `docs/runbooks/macos-launchd-deployment.md`
- Create: `loop-lag-forensic-collector.md` under `docs/runbooks/`
- Modify: `docs/superpowers/specs/2026-08-15-loop-lag-safe-forensic-pipeline-design.md`
- Modify: `docs/publication-audit.md`
- Modify: `docs/work-index.json`
- Modify: `docs/work-index.md`

- [ ] **Step 1: Update the approved design with C1-C6 disposition**

Record:

- `systemClock.now()` as the production wall-clock default;
- empty/no-cursor `next_after: 0` and empty/with-cursor preserving the input cursor;
- immutable one-copy ring pagination;
- the 180-second nominal ring span and operational requirement to poll no slower than 150 seconds, with intervals above 150 seconds explicitly documented as gap-guaranteed by the supported operating contract and intervals at/above the physical ring span guaranteed to evict even under ideal cadence;
- the same-PR prohibition on publishing/deploying `raw_recent` in `/health`;
- the six named ratchets from Task 8.

- [ ] **Step 2: Document the endpoint and collector truthfully**

`docs/public-surface.md` must distinguish public `/health`, privileged diagnostic `/health`, and privileged raw endpoint fields, authentication, status codes, budgets, and non-fallback behavior.

The collector runbook must include:

- schema discovery;
- a token-file-only loopback invocation;
- file modes and default 50 MiB retention;
- cursor/process/poll gap meanings;
- exit-code interpretation;
- the 150-second safe polling ceiling and 180-second physical ring span;
- a no-secret inspection command;
- cleanup that never removes the only evidence copy;
- explicit statement that samples are evidence, not automatic root-cause attribution.

The macOS deploy runbook must require authenticated `/health` byte measurement below 65,536 before supervision returns, raw endpoint measurement below 32 KiB, a local collector rehearsal, and a real served turn before interpreting results.

- [ ] **Step 3: Regenerate publication and work indexes**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run guard:publication:write
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run work-index:regen
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run guard:publication:all
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run guard:work-index
```

- [ ] **Step 4: Commit Task 7**

```bash
git add docs/public-surface.md docs/runbooks/macos-launchd-deployment.md \
  docs/runbooks/loop-lag-forensic-collector.md \
  docs/superpowers/specs/2026-08-15-loop-lag-safe-forensic-pipeline-design.md \
  docs/publication-audit.md docs/work-index.json docs/work-index.md
git diff --cached --check
git commit -m "docs(ops): document loop-lag evidence collection"
```

---

## Task 8: Run exact-head adversarial and repository verification

**Files:**

- Verify all files changed in Tasks 1-7
- Record receipts in the branch's existing PR draft or local verification artifact; do not create a PR in this task

- [ ] **Step 1: Run the focused product and downstream suites**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
npx vitest run \
  tests/lib/loop-lag-sampler.test.ts \
  tests/core/loop-lag-samples-endpoint.test.ts \
  tests/core/health.test.ts \
  tests/fleet/health-poller.test.ts \
  tests/fleet/routes/lines.test.ts \
  tests/deploy/watchdog-credential-dead.test.ts \
  tests/scripts/loop-lag-collector.test.ts \
  tests/scripts/collect-loop-lag-samples.test.ts \
  tests/lib/private-fs.test.ts
```

- [ ] **Step 2: Run all six file-scope ratchets explicitly (C6)**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
npx vitest run \
  tests/scripts/clock-budget.test.ts \
  tests/scripts/env-read-allowlist.test.ts \
  tests/scripts/secret-env-read-guard.test.ts \
  tests/scripts/fitness-file-size-warning-budget.test.ts \
  tests/scripts/fitness-sync-exec-timeout-budget.test.ts \
  tests/scripts/public-surface-drift-check.test.ts
```

- [ ] **Step 3: Run static, documentation, and release gates**

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
npm run typecheck
npm run typecheck:all
npm run typecheck:scripts
npm run guard:publication:all
npm run guard:work-index
npm run guard:public-surface-drift
npm run verify:release
git diff --check
```

- [ ] **Step 4: Run mutation falsifiers deliberately**

Temporarily mutate one condition at a time without committing, run its named test, observe RED, and restore the exact file with a reverse `apply_patch`:

1. rebase the timer deadline to `actualAtMs + cadence`;
2. replace the immutable ring copy with two live-ring reads;
3. return `raw_recent` in `/health`;
4. allow one non-loopback URL;
5. allow a redirect;
6. accept a malformed prior JSONL tail;
7. write a partial line at the retention boundary.

After each restore, rerun the named test GREEN and finish with `git diff --check`. Do not use `git checkout --`, `git restore .`, or reset commands.

- [ ] **Step 5: Run the definitive battery on an immutable head**

Commit any verified test-only corrections first. Capture:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
before=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"
npm run coverage:check
after=$(git rev-parse HEAD)
test "$before" = "$after"
test -z "$(git status --porcelain)"
```

The success receipt must include test files, pass/skip/fail counts, coverage thresholds, command exit, before/after SHA equality, and clean-tree assertions. A background exit without the decisive log tail is inconclusive.

- [ ] **Step 6: Perform final branch-history and C5 checks**

```bash
git diff --check origin/main...HEAD
if git log --format='%H%x00%s%x00%b%x1e' origin/main..HEAD | \
  rg -qi 'co-authored-by|claude|opus|sonnet|haiku|fable|noreply@anthropic|generated with'; then
  echo 'FATAL: prohibited public attribution in branch history' >&2
  exit 1
fi
if rg -n 'raw_recent' src; then
  echo 'FATAL: production raw_recent remains' >&2
  exit 1
fi
git range-diff origin/main...758dcba27 origin/main...HEAD
```

Any remaining production `raw_recent` occurrence blocks publication. Use the range-diff to show that the producer commit is contained and corrected, not silently dropped.

- [ ] **Step 7: Obtain a fresh adversarial code review**

Review exact `HEAD` for authentication bypass, body-budget arithmetic, cursor races, token disclosure, symlink/ownership races, JSONL partial writes, exit-code false success, fleet/console payload growth, and timer-phase regression. Verify every material finding in source or with a falsifier before changing code.

- [ ] **Step 8: Stop at the publication gate**

Report the exact local head, verification receipt, remaining risks, and rollback/deployment preconditions. Pushing the branch and opening a PR are separate externally mutating actions and require the owner's current instruction naming those actions and this branch. Merge and canary deployment each remain later independent gates.

---

## Completion Forecast and Downstream Impact

- **Direct producer callers:** `startHealthServer` is the only production owner of `LoopLagSampler`; polling the new endpoint must not create observations or affect starvation state.
- **Existing health consumers:** watchdog, fleet health poller, `/api/lines`, WebSocket line status, and console continue to receive aggregate health only. Their payloads should shrink relative to `758dcba27`.
- **New consumer:** the local collector is the only durable raw consumer. Its cursor is process-incarnation scoped, and every loss boundary becomes a record rather than an inferred clean interval.
- **Operational effect:** no database migration, provider call, WhatsApp send, fleet mutation, or remote control action. The collector performs authenticated loopback GETs and private local appends only.
- **Rollout dependency:** the timer-phase correction and endpoint correction must land together before #3253 evidence is interpreted. A real served turn is required after canary deployment because startup-only health cannot prove the original affected-instance traffic condition is gone.
- **Expected implementation sequence:** Tasks 1-4 establish a safely consumable producer; Tasks 5-6 establish durable capture; Task 7 aligns operator truth; Task 8 decides whether the exact head is publishable. Discovery of a body-budget or security failure returns to the owning task instead of weakening the stated contract.
