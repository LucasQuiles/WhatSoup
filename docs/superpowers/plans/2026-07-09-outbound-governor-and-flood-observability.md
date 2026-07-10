# Outbound Governor and Flood Observability Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate outbound-governor configuration, enforce a real enqueue-to-admission deadline with bounded waiters, and count every outbound socket attempt exactly once.

**Architecture:** The shared instance validator owns the persisted configuration contract. `OutboundRateLimiter` captures a deadline before joining its FIFO chain and refuses excess waiters. The existing in-place `sendMessage` wrapper remains the universal transport seam and receives one failure-isolated observer callback for flood accounting.

**Tech Stack:** TypeScript, Zod-style shared instance validation, node timers, Vitest fake timers, Baileys socket test doubles.

## Global Constraints

- Start from a freshly fetched `origin/main`; the audited base was `7330bafb`.
- Preserve socket object identity; do not introduce a Proxy around the Baileys socket.
- Pace only genuine text; media and control payloads remain pacing-exempt.
- Never use a raw JID or phone as a metric label or surfaced health identifier.
- A detector/observer failure must never perturb the real send.
- Use the pinned Node/npm wrappers for every test and check.
- Keep WS-C01, WS-C02, and WS-C03 as separate PRs and commits.

---

## File Structure

### WS-C01 — Config contract

- Modify `src/transport/outbound-governor.ts` — export the complete runtime config contract, including waiter cap.
- Modify `src/core/agent-config-validator.ts` — validate nested type, integer/range, and cross-field relations.
- Modify `src/instance-loader.ts` — type the optional persisted block.
- Modify `src/config.ts` — consume a validated block without unchecked nested casts.
- Modify `src/fleet/routes/ops.ts` — allow create/patch persistence of the block.
- Modify `docs/configuration.md` and `docs/public-surface.md` — publish fields/defaults/constraints.
- Test `tests/core/agent-config-validator.test.ts` and `tests/fleet/ops-config-patch-validation.test.ts`.

### WS-C02 — Deadline and waiter cap

- Modify `src/transport/outbound-rate-limiter.ts` — deadline-at-enqueue, pending counters, cap result.
- Modify `src/transport/outbound-governor.ts` — map limiter outcomes to stable shed reasons.
- Test `tests/transport/outbound-rate-limiter.test.ts` and `tests/transport/outbound-governor.test.ts`.

### WS-C03 — Universal flood observation

- Modify `src/transport/outbound-governor.ts` — add the observer callback to the socket wrapper.
- Modify `src/transport/connection.ts` — wire the detector once and delete per-method counting.
- Test `tests/transport/outbound-governor-wiring.test.ts`, `tests/transport/outbound-flood-detector.test.ts`, and a new Tier-C regression case in the wiring suite.

---

### Task 1: Add red tests for the persisted governor contract

**Files:**

- Modify: `tests/core/agent-config-validator.test.ts`
- Modify: `tests/fleet/ops-config-patch-validation.test.ts`

**Interfaces:**

- Consumes: `validateInstanceConfig(raw, context)` from `src/core/agent-config-validator.ts`.
- Produces: a locked contract for `outboundGovernor.enabled`, pacing windows/caps, ceiling fields, global fields, and `maxPendingPerKey`.

- [ ] **Step 1: Add load-mode type/range/relation failures**

```ts
const validGovernor = {
  enabled: true,
  windowMs: 3_000,
  maxPerWindow: 6,
  maxWaitMs: 5_000,
  hardCeiling: 120,
  hardCeilingWindowMs: 3_600_000,
  globalMaxPerWindow: 40,
  globalWindowMs: 3_000,
  maxPendingPerKey: 256,
};

it.each([
  [{ ...validGovernor, enabled: 'yes' }, 'outboundGovernor.enabled'],
  [{ ...validGovernor, windowMs: 0 }, 'outboundGovernor.windowMs'],
  [{ ...validGovernor, maxPerWindow: 1.5 }, 'outboundGovernor.maxPerWindow'],
  [{ ...validGovernor, maxWaitMs: 2_999 }, 'outboundGovernor.maxWaitMs'],
  [{ ...validGovernor, hardCeiling: 5 }, 'outboundGovernor.hardCeiling'],
  [{ ...validGovernor, hardCeilingWindowMs: 2_999 }, 'outboundGovernor.hardCeilingWindowMs'],
  [{ ...validGovernor, maxPendingPerKey: 0 }, 'outboundGovernor.maxPendingPerKey'],
])('rejects invalid outbound governor %#', (outboundGovernor, field) => {
  const error = validateInstanceConfig(
    { ...validBaseConfig(), outboundGovernor },
    { name: 'test', mode: 'load' },
  );
  expect(error?.field).toBe(field);
});
```

The relation cases encode `maxWaitMs >= windowMs`, `hardCeiling >= maxPerWindow`, and `hardCeilingWindowMs >= windowMs`. The aggregate global cap remains independently configurable because an operator may intentionally set it below the per-destination cap.

- [ ] **Step 2: Add create/patch persistence tests**

```ts
it('accepts and preserves a valid outboundGovernor block on PATCH', async () => {
  const response = await patchInstance('test-line', { outboundGovernor: validGovernor });
  expect(response.status).toBe(200);
  expect(readConfig('test-line').outboundGovernor).toEqual(validGovernor);
});

it('rejects an invalid outboundGovernor block before writing config', async () => {
  const before = readConfig('test-line');
  const response = await patchInstance('test-line', {
    outboundGovernor: { ...validGovernor, maxWaitMs: 10 },
  });
  expect(response.status).toBe(400);
  expect(readConfig('test-line')).toEqual(before);
});
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/agent-config-validator.test.ts tests/fleet/ops-config-patch-validation.test.ts --pool=forks --fileParallelism=false
```

Expected: FAIL because the validator currently ignores the block and the route does not persist it.

### Task 2: Implement the typed governor configuration contract

**Files:**

- Modify: `src/transport/outbound-governor.ts`
- Modify: `src/core/agent-config-validator.ts`
- Modify: `src/instance-loader.ts`
- Modify: `src/config.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: `docs/configuration.md`
- Modify: `docs/public-surface.md`

**Interfaces:**

- Produces: `OutboundGovernorConfig` with `maxPendingPerKey: number`.
- Produces: a shared validator result whose `field` is the exact nested path.
- Consumes later: `OutboundRateLimiter(maxPerWindow, windowMs, { maxPendingPerKey })` in Task 5.

- [ ] **Step 1: Extend the runtime contract and defaults**

```ts
export interface OutboundGovernorConfig {
  windowMs: number;
  maxPerWindow: number;
  maxWaitMs: number;
  hardCeiling: number;
  hardCeilingWindowMs: number;
  globalMaxPerWindow: number;
  globalWindowMs: number;
  maxPendingPerKey: number;
}

export const DEFAULT_OUTBOUND_GOVERNOR: Readonly<OutboundGovernorConfig> = {
  windowMs: 3_000,
  maxPerWindow: 6,
  maxWaitMs: 5_000,
  hardCeiling: 120,
  hardCeilingWindowMs: 3_600_000,
  globalMaxPerWindow: 40,
  globalWindowMs: 3_000,
  maxPendingPerKey: 256,
};
```

- [ ] **Step 2: Add a nested record validator**

Add a local helper in `src/core/agent-config-validator.ts` that returns the first exact error:

```ts
function validateOutboundGovernor(raw: unknown): ValidationError | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return err('outboundGovernor', 'outboundGovernor must be an object');
  if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') {
    return err('outboundGovernor.enabled', 'outboundGovernor.enabled must be a boolean');
  }

  const integers = [
    ['windowMs', 1, 60_000],
    ['maxPerWindow', 1, 10_000],
    ['maxWaitMs', 1, 60_000],
    ['hardCeiling', 1, 100_000],
    ['hardCeilingWindowMs', 1_000, 86_400_000],
    ['globalMaxPerWindow', 1, 100_000],
    ['globalWindowMs', 1, 60_000],
    ['maxPendingPerKey', 1, 10_000],
  ] as const;
  for (const [name, min, max] of integers) {
    const value = raw[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      return err(`outboundGovernor.${name}`, `outboundGovernor.${name} must be an integer between ${min} and ${max}`);
    }
  }

  const cfg = { ...DEFAULT_OUTBOUND_GOVERNOR, ...raw } as OutboundGovernorConfig;
  if (cfg.maxWaitMs < cfg.windowMs) {
    return err('outboundGovernor.maxWaitMs', 'outboundGovernor.maxWaitMs must be greater than or equal to windowMs');
  }
  if (cfg.hardCeiling < cfg.maxPerWindow) {
    return err('outboundGovernor.hardCeiling', 'outboundGovernor.hardCeiling must be greater than or equal to maxPerWindow');
  }
  if (cfg.hardCeilingWindowMs < cfg.windowMs) {
    return err('outboundGovernor.hardCeilingWindowMs', 'outboundGovernor.hardCeilingWindowMs must be greater than or equal to windowMs');
  }
  return null;
}
```

Call it from `validateInstanceConfig` before returning success.

- [ ] **Step 3: Type load/create/patch**

Add to `InstanceConfig`:

```ts
outboundGovernor?: Partial<OutboundGovernorConfig> & { enabled?: boolean };
```

Add `'outboundGovernor'` to `PASSTHROUGH_FIELDS`. In `src/config.ts`, replace field-by-field unchecked casts with:

```ts
const configuredOutboundGovernor = instance?.outboundGovernor ?? {};

outboundGovernor: {
  enabled: configuredOutboundGovernor.enabled ?? true,
  ...DEFAULT_OUTBOUND_GOVERNOR,
  ...configuredOutboundGovernor,
},
```

Keep `enabled` outside `OutboundGovernorConfig` if the constructor continues to receive only enabled numeric settings.

- [ ] **Step 4: Document exact fields and constraints**

Add one configuration table with the eight numeric defaults plus `enabled`, and state the three cross-field relations encoded above. Update public-surface inventory if configuration fields are enumerated there.

- [ ] **Step 5: Run focused and type checks**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/agent-config-validator.test.ts tests/fleet/ops-config-patch-validation.test.ts tests/transport/outbound-governor-wiring.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:instance-config
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit WS-C01**

```bash
git add src/transport/outbound-governor.ts src/core/agent-config-validator.ts src/instance-loader.ts src/config.ts src/fleet/routes/ops.ts docs/configuration.md docs/public-surface.md tests/core/agent-config-validator.test.ts tests/fleet/ops-config-patch-validation.test.ts
git commit -m "fix(config): validate outbound governor settings"
```

### Task 3: Add red tests for enqueue-to-admission deadlines

**Files:**

- Modify: `tests/transport/outbound-rate-limiter.test.ts`
- Modify: `tests/transport/outbound-governor.test.ts`

**Interfaces:**

- Produces: required result shape `{ delayMs, capped, reason?: 'deadline' | 'pending-cap' }`.

- [ ] **Step 1: Prove cumulative FIFO delay is capped**

```ts
it('measures maxWaitMs from enqueue rather than from FIFO turn start', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const limiter = new OutboundRateLimiter(1, 100, { maxPendingPerKey: 8 });

  const first = limiter.acquireBounded('chat', 150);
  const second = limiter.acquireBounded('chat', 150);
  const third = limiter.acquireBounded('chat', 150);
  const fourth = limiter.acquireBounded('chat', 150);

  await vi.advanceTimersByTimeAsync(151);
  expect(await first).toMatchObject({ capped: false });
  expect(await second).toMatchObject({ capped: false });
  expect(await third).toEqual({ delayMs: 151, capped: true, reason: 'deadline' });
  expect(await fourth).toEqual({ delayMs: 151, capped: true, reason: 'deadline' });
});
```

- [ ] **Step 2: Prove waiter count is bounded synchronously**

```ts
it('rejects a waiter when the per-key pending cap is reached', async () => {
  vi.useFakeTimers();
  const limiter = new OutboundRateLimiter(1, 1_000, { maxPendingPerKey: 2 });
  void limiter.acquireBounded('chat', 5_000);
  void limiter.acquireBounded('chat', 5_000);
  await expect(limiter.acquireBounded('chat', 5_000)).resolves.toEqual({
    delayMs: 0,
    capped: true,
    reason: 'pending-cap',
  });
  expect(limiter.pendingFor('chat')).toBe(2);
});
```

- [ ] **Step 3: Run and confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/transport/outbound-rate-limiter.test.ts tests/transport/outbound-governor.test.ts --pool=forks --fileParallelism=false
```

Expected: compile/test failure because options, `reason`, and `pendingFor` do not exist and cumulative FIFO requests settle after the deadline.

### Task 4: Implement deadline capture and pending accounting

**Files:**

- Modify: `src/transport/outbound-rate-limiter.ts`

**Interfaces:**

- Produces: `BoundedAcquireResult` with optional reason.
- Produces: `pendingFor(destination): number` for health/tests.

- [ ] **Step 1: Extend the result and constructor**

```ts
export interface BoundedAcquireResult {
  delayMs: number;
  capped: boolean;
  reason?: 'deadline' | 'pending-cap';
}

export interface OutboundRateLimiterOptions {
  maxPendingPerKey?: number;
}

private readonly pending = new Map<string, number>();
private readonly maxPendingPerKey: number;

constructor(maxPerWindow: number, windowMs: number, opts: OutboundRateLimiterOptions = {}) {
  this.maxPerWindow = Math.max(1, Math.floor(maxPerWindow));
  this.windowMs = windowMs;
  this.maxPendingPerKey = Math.max(1, Math.floor(opts.maxPendingPerKey ?? 256));
}
```

- [ ] **Step 2: Capture the deadline before joining FIFO**

```ts
async acquireBounded(destination: string, maxWaitMs: number): Promise<BoundedAcquireResult> {
  const enqueuedAt = Date.now();
  const pending = this.pending.get(destination) ?? 0;
  if (pending >= this.maxPendingPerKey) {
    return { delayMs: 0, capped: true, reason: 'pending-cap' };
  }
  this.pending.set(destination, pending + 1);
  try {
    return await this.enqueue(
      destination,
      () => this.reserveSlotBoundedUntil(destination, enqueuedAt, enqueuedAt + maxWaitMs),
    );
  } finally {
    const remaining = (this.pending.get(destination) ?? 1) - 1;
    if (remaining <= 0) this.pending.delete(destination);
    else this.pending.set(destination, remaining);
  }
}

pendingFor(destination: string): number {
  return this.pending.get(destination) ?? 0;
}
```

- [ ] **Step 3: Replace the reservation-local timer**

```ts
private async reserveSlotBoundedUntil(
  destination: string,
  enqueuedAt: number,
  deadlineAt: number,
): Promise<BoundedAcquireResult> {
  const window = this.getWindow(destination);
  for (;;) {
    const now = Date.now();
    this.pruneWindow(window, now);
    if (now >= deadlineAt) {
      return { delayMs: now - enqueuedAt, capped: true, reason: 'deadline' };
    }
    if (window.length < this.maxPerWindow) {
      window.push(now);
      return { delayMs: now - enqueuedAt, capped: false };
    }
    const waitMs = Math.max(1, window[0]! + this.windowMs - now);
    if (now + waitMs > deadlineAt) {
      return { delayMs: now - enqueuedAt, capped: true, reason: 'deadline' };
    }
    await sleep(waitMs);
  }
}
```

- [ ] **Step 4: Run focused tests**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/transport/outbound-rate-limiter.test.ts --pool=forks --fileParallelism=false
```

Expected: all limiter tests pass; no promise remains pending after fake-time advancement.

### Task 5: Wire limiter outcomes through the governor

**Files:**

- Modify: `src/transport/outbound-governor.ts`
- Modify: `tests/transport/outbound-governor.test.ts`

**Interfaces:**

- Consumes: `maxPendingPerKey` from Task 2 and deadline/cap results from Task 4.
- Produces: existing stable `ShedReason`; logs may add `capReason` metadata without changing the public error code.

- [ ] **Step 1: Construct both pacing limiters with the cap**

```ts
this.perDest = new OutboundRateLimiter(cfg.maxPerWindow, cfg.windowMs, {
  maxPendingPerKey: cfg.maxPendingPerKey,
});
this.global = new OutboundRateLimiter(cfg.globalMaxPerWindow, cfg.globalWindowMs, {
  maxPendingPerKey: cfg.maxPendingPerKey,
});
```

Retain the synchronous ceiling limiter without pending options.

- [ ] **Step 2: Lock the user-visible shed mapping**

```ts
const perDest = await this.perDest.acquireBounded(dest, this.maxWaitMs);
if (perDest.capped) return 'pace-per-dest';
const global = await this.global.acquireBounded(GLOBAL_BUCKET_KEY, this.maxWaitMs);
if (global.capped) return 'pace-global';
```

Add tests for both `deadline` and `pending-cap` internal outcomes mapping to the same stable external reason; do not add new retryable error codes.

- [ ] **Step 3: Run transport tests and typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/transport/outbound-rate-limiter.test.ts tests/transport/outbound-governor.test.ts tests/transport/outbound-governor-wiring.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit WS-C02**

```bash
git add src/transport/outbound-rate-limiter.ts src/transport/outbound-governor.ts tests/transport/outbound-rate-limiter.test.ts tests/transport/outbound-governor.test.ts
git commit -m "fix(transport): enforce governor enqueue deadlines"
```

### Task 6: Add red Tier-C flood-observation tests

**Files:**

- Modify: `tests/transport/outbound-governor-wiring.test.ts`
- Modify: `tests/transport/outbound-flood-detector.test.ts`

**Interfaces:**

- Produces: `observeSendAttempt(jid: string): void` wrapper option.

- [ ] **Step 1: Prove a raw socket tool is observed once**

```ts
it('observes Tier-C raw socket sends exactly once', async () => {
  const observeSendAttempt = vi.fn();
  const socket = makeSocket();
  const wrapped = wrapWithOutboundGovernor(socket, {
    governor: passthroughGovernor(),
    resolveDest: (jid) => jid,
    observeSendAttempt,
  });

  await wrapped.sendMessage('15550001111@s.whatsapp.net', { sharePhoneNumber: true });

  expect(observeSendAttempt).toHaveBeenCalledTimes(1);
  expect(observeSendAttempt).toHaveBeenCalledWith('15550001111@s.whatsapp.net');
  expect(socket.sendMessage).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Prove observer failure cannot block delivery**

```ts
it('still sends when the flood observer throws', async () => {
  const socket = makeSocket();
  const wrapped = wrapWithOutboundGovernor(socket, {
    governor: passthroughGovernor(),
    resolveDest: (jid) => jid,
    observeSendAttempt: () => { throw new Error('observer failed'); },
  });
  await expect(wrapped.sendMessage('15550001111@s.whatsapp.net', { image: Buffer.from('x') }))
    .resolves.toEqual(expect.anything());
});
```

- [ ] **Step 3: Prove governor-shed text is not counted as sent**

Create a governor test double returning `pace-per-dest`, call wrapped text send, assert rejection and `observeSendAttempt` not called.

- [ ] **Step 4: Run and confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/transport/outbound-governor-wiring.test.ts tests/transport/outbound-flood-detector.test.ts --pool=forks --fileParallelism=false
```

Expected: compile/test failure because the wrapper has no observer option and Tier-C calls bypass the ConnectionManager's per-method counters.

### Task 7: Move flood accounting to the wrapper seam

**Files:**

- Modify: `src/transport/outbound-governor.ts`
- Modify: `src/transport/connection.ts`

**Interfaces:**

- Consumes: `observeSendAttempt(jid: string): void` from Task 6.
- Preserves: `OutboundFloodDetector.record`, health snapshot fields, and alert behavior.

- [ ] **Step 1: Add the failure-isolated observer option**

```ts
export interface WrapOutboundGovernorOptions {
  governor: OutboundGovernor;
  resolveDest: (jid: string) => string;
  observeSendAttempt?: (jid: string) => void;
  log?: GovernorLog;
}
```

Immediately before `realSend`:

```ts
try {
  opts.observeSendAttempt?.(jid);
} catch {
  // Observability never perturbs delivery.
}
return realSend(jid, content, ...rest);
```

Place this after text gating so a shed attempt is not counted as a socket send, and before `realSend` so transport failures remain observable attempts.

- [ ] **Step 2: Wire the existing detector**

At socket installation in `ConnectionManager`, pass:

```ts
observeSendAttempt: (jid) => this.countOutboundSend(jid),
```

Delete the four direct `this.countOutboundSend(chatJid)` calls from `sendMessage`, `sendRaw`, `sendPollMessage`, and `sendMedia`. Keep `countOutboundSend` private and keep its failure swallowing and alert edge behavior unchanged.

- [ ] **Step 3: Run focused and broad transport suites**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/transport/outbound-governor-wiring.test.ts tests/transport/outbound-flood-detector.test.ts tests/transport/connection.test.ts tests/mcp/tools/advanced.test.ts tests/mcp/tools/groups.test.ts tests/mcp/tools/status.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: all commands exit 0; Tier A, B, and C each observe exactly one attempt.

- [ ] **Step 4: Commit WS-C03**

```bash
git add src/transport/outbound-governor.ts src/transport/connection.ts tests/transport/outbound-governor-wiring.test.ts tests/transport/outbound-flood-detector.test.ts
git commit -m "fix(observability): count sends at the socket wrapper"
```

### Task 8: Run release verification for each branch tip

**Files:** None.

**Interfaces:** Produces three independent verification receipts, one for each PR branch.

- [ ] **Step 1: Run the full release gate**

```bash
loadgate --slots 4 --max-load 21 -- bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: exit 0. If Playwright reports a missing executable, run the repository's browser preflight/install instruction and rerun; a zero-browser-test run is inconclusive.

- [ ] **Step 2: Run dependency audit**

```bash
bash scripts/run-with-pinned-npm.sh audit --omit=dev
```

Expected: exit 0 with zero production vulnerabilities.

- [ ] **Step 3: Record residual risk in each PR body**

State that fake socket and fake timer tests do not prove production WhatsApp/Baileys timing. Require a staging canary that sends one Tier-A text, one Tier-B media/poll, and one Tier-C raw action while confirming exactly one detector increment per action and no raw identifier in telemetry.

## Self-Review

- Spec coverage: WS-C01, WS-C02, and WS-C03 each map to a separate task/commit and their design invariants are covered.
- Deferred-step scan: no deferred implementation step or unspecified error handling remains.
- Type consistency: `maxPendingPerKey` is defined in Task 2 and consumed in Tasks 4-5; `observeSendAttempt` is defined in Task 6 and consumed in Task 7.
- Scope boundary: no unrelated transport refactor, health schema change, or alert redesign is included.
