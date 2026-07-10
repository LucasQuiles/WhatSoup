# Delivery Audit and Idempotency Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve transport-delivery truth when audit finalization fails, reconcile audit uncertainty without resending, and reuse one stable logical delivery identity across eligible ChatRuntime and scheduled-text retries.

**Architecture:** WS-A04 separates the transport attempt from audit bookkeeping: a receipt is returned even when audit finalization is queued in a content-free reconciliation table, and health remains degraded until an idempotent sweep repairs it. WS-A05 declares each transport's idempotency capability, shares one message-ID generator, and persists scheduled-text identity across ticks; ambiguous failures on a transport without idempotency stop for manual verification.

**Tech Stack:** TypeScript ESM, Node.js 24.15.0, npm 11.12.1, `node:sqlite`, Vitest, existing `SendPipeline`, `OutboundSendsWriter`, `Messenger`, `RuntimeConnection`, ChatRuntime, and MessageScheduler.

## Global Constraints

- Start from audited base `7330bafbe77d7a15febce32eb09b304e8778862f`; rebase after the complete durable-inbound train reserves migrations 37 and 38.
- Local branch and commits only; pushing or opening Draft PRs requires explicit approval.
- Keep WS-A04 and WS-A05 independently revertible.
- A transport receipt must never become caller failure, `markFailure`, or resend because audit finalization failed.
- Audit uncertainty stores IDs, bounded error class, attempts, and time only—never message text.
- One logical eligible send uses one stable identity; a different logical send uses a different identity.
- A transport without declared idempotency may not retry an ambiguous post-handoff outcome.
- Metrics use low-cardinality counts/age and no raw conversation identity.
- Preserve Node `>=24.0.0 <26` and npm `11.12.1`; use pinned wrappers.
- Run the full pinned release gate before either PR is ready; live WhatsApp/Twilio checks remain explicit staging gaps.

---

## File Structure

- WS-A04: modify `src/core/database.ts`, `src/core/outbound-sends.ts`, `src/core/send-pipeline.ts`, `src/core/health.ts`, `src/main.ts`, focused tests, `docs/configuration.md`, and `docs/durability.md`.
- WS-A05: create `src/core/delivery-identity.ts`; modify `src/core/types.ts`, chat/agent retry paths, scheduler, runtime transport interfaces/implementations, Twilio classification, migrations/tests, and transport durability docs.

---

### Task 1: Add the audit-reconciliation schema (WS-A04, commit 1)

**Files:**
- Modify: `src/core/database.ts:556-737, after runMigration38`
- Create: `tests/core/migration-39-outbound-audit-reconciliation.test.ts`
- Modify: `docs/configuration.md:1430-1475`

**Interfaces:**
- Consumes: `outbound_sends.id`.
- Produces: `outbound_audit_reconciliation` and `idx_outbound_audit_reconciliation_due`.

- [ ] **Step 1: Write the failing migration test**

```ts
// tests/core/migration-39-outbound-audit-reconciliation.test.ts
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

describe('migration 39', () => {
  it('creates a content-free due-ordered audit reconciliation table', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(39);
      const columns = db.raw.prepare(
        "PRAGMA table_info('outbound_audit_reconciliation')",
      ).all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toEqual([
        'audit_id', 'transport_message_id', 'attempt_count',
        'last_error_class', 'next_attempt_at', 'created_at', 'updated_at',
      ]);
      expect(columns.map((c) => c.name)).not.toEqual(
        expect.arrayContaining(['text', 'payload', 'error_message']),
      );
      const index = db.raw.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type='index' AND name='idx_outbound_audit_reconciliation_due'
      `).get() as { sql: string };
      expect(index.sql).toContain('next_attempt_at, audit_id');
    } finally { db.close(); }
  });
});
```

- [ ] **Step 2: Verify the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-39-outbound-audit-reconciliation.test.ts --pool=forks`

Expected: FAIL because schema 39/table is absent; runner/setup failure is inconclusive.

- [ ] **Step 3: Implement migration 39**

```ts
function runMigration39(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_audit_reconciliation (
      audit_id INTEGER PRIMARY KEY REFERENCES outbound_sends(id) ON DELETE CASCADE,
      transport_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_class TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_audit_reconciliation_due
      ON outbound_audit_reconciliation(next_attempt_at, audit_id);
  `);
}
```

Add `[39, runMigration39]` after `[38, runMigration38]`. Add:

```markdown
| 39 | Adds content-free `outbound_audit_reconciliation` for transport-delivered sends whose audit finalization is pending. |
```

- [ ] **Step 4: Verify and commit**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-39-outbound-audit-reconciliation.test.ts tests/core/migration-safety.test.ts tests/core/database.test.ts --pool=forks`

Expected: PASS.

```bash
git add src/core/database.ts tests/core/migration-39-outbound-audit-reconciliation.test.ts docs/configuration.md
git commit -m "feat(audit): add delivery reconciliation journal"
```

### Task 2: Separate transport and audit exception boundaries (WS-A04, commit 2)

**Files:**
- Modify: `src/core/outbound-sends.ts:23-209`
- Modify: `src/core/send-pipeline.ts:17-137`
- Modify: `tests/core/outbound-sends.test.ts`
- Modify: `tests/core/send-pipeline.test.ts:37-185`

**Interfaces:**
- Produces: `markAuditPending`, `reconcilePending`, `getAuditHealth`; transport results survive audit errors.

- [ ] **Step 1: Write the delivery-truth fault tests**

Append to `tests/core/send-pipeline.test.ts`:

```ts
it('returns a receipt and queues audit repair when markSuccess throws', async () => {
  const writer = {
    writeIntent: vi.fn(() => 41),
    markSuccess: vi.fn(() => { throw new Error('synthetic audit write fault'); }),
    markFailure: vi.fn(),
    markAuditPending: vi.fn(),
    reconcilePending: vi.fn(() => 0),
    getAuditHealth: vi.fn(() => ({ pending: 1, oldestAgeSeconds: 0 })),
    listRecent: vi.fn(() => []),
  };
  const transport = vi.fn(async () => ({ transportId: 'wamid.delivered.once' }));
  const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'mcp' });
  await expect(pipeline.executeSend(
    { chatJid: 'delivered@s.whatsapp.net', text: 'one transport call' }, transport,
  )).resolves.toEqual({ transportId: 'wamid.delivered.once' });
  expect(transport).toHaveBeenCalledOnce();
  expect(writer.markFailure).not.toHaveBeenCalled();
  expect(writer.markAuditPending).toHaveBeenCalledWith(41, 'wamid.delivered.once', 'Error');
});

it('rethrows the original transport error when markFailure also throws', async () => {
  const transportError = new Error('transport failed');
  const writer = {
    writeIntent: vi.fn(() => 42), markSuccess: vi.fn(),
    markFailure: vi.fn(() => { throw new Error('audit failed'); }),
    markAuditPending: vi.fn(), reconcilePending: vi.fn(() => 0),
    getAuditHealth: vi.fn(() => ({ pending: 0, oldestAgeSeconds: null })),
    listRecent: vi.fn(() => []),
  };
  const pipeline = createSendPipeline({ resolver: chatResolver, auditWriter: writer, caller: 'health' });
  await expect(pipeline.executeSend(
    { chatJid: 'failed@s.whatsapp.net', text: 'not delivered' },
    async () => { throw transportError; },
  )).rejects.toBe(transportError);
});
```

Append to `tests/core/outbound-sends.test.ts`:

```ts
it('reconciles pending delivery audit without transport', () => {
  const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
  const id = writer.writeIntent({
    caller: 'mcp', chatJid: 'audit@s.whatsapp.net',
    targetKind: 'chatJid', text: 'private body',
  });
  writer.markAuditPending(id, 'wamid.pending', 'SqliteError', 1_800_000_000);
  expect(writer.getAuditHealth(1_800_000_001)).toEqual({
    pending: 1, oldestAgeSeconds: expect.any(Number),
  });
  expect(writer.reconcilePending(10, 1_800_000_010)).toBe(1);
  expect(db.raw.prepare(
    'SELECT status, transport_message_id FROM outbound_sends WHERE id=?',
  ).get(id)).toEqual({ status: 'sent', transport_message_id: 'wamid.pending' });
  expect(writer.reconcilePending(10, 1_800_000_020)).toBe(0);
});
```

- [ ] **Step 2: Verify the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/send-pipeline.test.ts tests/core/outbound-sends.test.ts --pool=forks`

Expected: FAIL because the current shared catch calls `markFailure` and rejects after `markSuccess` fails.

- [ ] **Step 3: Extend OutboundSendsWriter**

Add to the interface:

```ts
markAuditPending(id: number, transportId: string | null, errorClass: string, now?: number): void;
reconcilePending(limit?: number, now?: number): number;
getAuditHealth(now?: number): { pending: number; oldestAgeSeconds: number | null };
```

Prepare these statements:

```ts
const upsertPending = db.prepare(`
  INSERT INTO outbound_audit_reconciliation
    (audit_id, transport_message_id, last_error_class, next_attempt_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(audit_id) DO UPDATE SET
    transport_message_id=excluded.transport_message_id,
    last_error_class=excluded.last_error_class,
    next_attempt_at=excluded.next_attempt_at,
    updated_at=datetime('now')
`);
const selectPending = db.prepare(`
  SELECT audit_id, transport_message_id FROM outbound_audit_reconciliation
  WHERE next_attempt_at<=? ORDER BY next_attempt_at, audit_id LIMIT ?
`);
const deletePending = db.prepare(
  'DELETE FROM outbound_audit_reconciliation WHERE audit_id=?',
);
const bumpPending = db.prepare(`
  UPDATE outbound_audit_reconciliation
  SET attempt_count=attempt_count+1, next_attempt_at=?, updated_at=datetime('now')
  WHERE audit_id=?
`);
const pendingHealth = db.prepare(`
  SELECT COUNT(*) AS pending, MIN(unixepoch(created_at)) AS oldest_at
  FROM outbound_audit_reconciliation
`);
```

Add methods:

```ts
markAuditPending(id, transportId, errorClass, now = Math.floor(Date.now() / 1000)): void {
  upsertPending.run(id, transportId, sanitizeErrorClass(errorClass), now + 5);
},
reconcilePending(limit = 100, now = Math.floor(Date.now() / 1000)): number {
  const rows = selectPending.all(now, Math.max(1, Math.min(100, Math.floor(limit)))) as
    unknown as Array<{ audit_id: number; transport_message_id: string | null }>;
  let count = 0;
  for (const row of rows) {
    try {
      const result = markSent.run(row.transport_message_id, row.audit_id);
      if (Number(result.changes) === 0) {
        const status = selectStatus.get(row.audit_id) as { status: string } | undefined;
        if (status?.status !== 'sent') throw new Error('audit row not reconcilable');
      }
      deletePending.run(row.audit_id);
      count += 1;
    } catch { bumpPending.run(now + 30, row.audit_id); }
  }
  return count;
},
getAuditHealth(now = Math.floor(Date.now() / 1000)) {
  const row = pendingHealth.get() as { pending: number; oldest_at: number | null };
  return {
    pending: row.pending,
    oldestAgeSeconds: row.oldest_at === null ? null : Math.max(0, now - row.oldest_at),
  };
},
```

Add:

```ts
function sanitizeErrorClass(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
}
```

- [ ] **Step 4: Split SendPipeline catches**

Add `createChildLogger`, `const log = createChildLogger('send-pipeline')`, and:

```ts
function auditErrorClass(err: unknown): string {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name ? name.slice(0, 64) : typeof err;
}
```

Replace current lines 123-134:

```ts
let result: T;
try { result = await transport(prepared); }
catch (transportErr) {
  if (auditId !== undefined) {
    try { auditWriter!.markFailure(auditId, errorMessage(transportErr)); }
    catch (auditErr) {
      log.error({ auditId, auditErrorClass: auditErrorClass(auditErr) },
        'transport failure audit finalization incomplete');
    }
  }
  throw transportErr;
}
if (auditId !== undefined) {
  const transportId = extractTransportId(result);
  try { auditWriter!.markSuccess(auditId, transportId); }
  catch (auditErr) {
    try { auditWriter!.markAuditPending(auditId, transportId, auditErrorClass(auditErr)); }
    catch (pendingErr) {
      log.error({ auditId, pendingErrorClass: auditErrorClass(pendingErr) },
        'delivered send audit repair could not be persisted');
    }
  }
}
return result;
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/send-pipeline.test.ts tests/core/outbound-sends.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS with exactly one transport call and no `markFailure` after receipt.

```bash
git add src/core/outbound-sends.ts src/core/send-pipeline.ts tests/core/outbound-sends.test.ts tests/core/send-pipeline.test.ts
git commit -m "fix(send): separate delivery from audit finalization"
```

### Task 3: Surface and reconcile audit gaps (WS-A04, commit 3)

**Files:**
- Modify: `src/core/health.ts:55-149, 1080-1277`
- Modify: `src/main.ts:147-153, 740-799, 972-1015`
- Modify: `tests/core/health.test.ts:118-142, near existing outbound_sends health assertions at 1924`
- Modify: `docs/durability.md`

**Interfaces:**
- Consumes: writer health/reconciliation methods.
- Produces: `outbound_sends.audit_pending`, `audit_oldest_age_seconds`, degraded health, 10-second repair sweep.

- [ ] **Step 1: Add the health test**

```ts
it('degrades health while delivered-send audit is pending', async () => {
  const db = makeDb();
  const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
  const id = writer.writeIntent({
    caller: 'health', chatJid: 'audit-health@s.whatsapp.net',
    targetKind: 'chatJid', text: 'canary',
  });
  writer.markAuditPending(id, 'wamid.health', 'SqliteError');
  const { server, port } = await buildTestServer(makeDeps(db, { auditWriter: writer }));
  try {
    const response = await httpReq(port, '/health', 'GET');
    const json = JSON.parse(response.body);
    expect(response.status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.outbound_sends).toMatchObject({
      audit_pending: 1, audit_oldest_age_seconds: expect.any(Number),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
```

- [ ] **Step 2: Verify red, then implement health fields**

Run `bash scripts/run-with-pinned-npm.sh test -- tests/core/health.test.ts --pool=forks`. Expected: FAIL because pending audit is invisible.

```ts
const audit = deps.auditWriter?.getAuditHealth() ?? { pending: 0, oldestAgeSeconds: null };
const outboundSends = {
  ...latestSuccessfulOutboundSend(deps),
  audit_pending: audit.pending,
  audit_oldest_age_seconds: audit.oldestAgeSeconds,
};
```

Compute this before status selection; include `outboundSends.audit_pending > 0` in the degraded condition and keep `outbound_sends: outboundSends` in the response.

- [ ] **Step 3: Add the bounded main sweep**

```ts
outboundSendsWriter.reconcilePending(100);
const outboundAuditInterval = setInterval(() => {
  try {
    const reconciled = outboundSendsWriter.reconcilePending(100);
    if (reconciled > 0) log.info({ reconciled }, 'outbound audit reconciled');
  } catch (err) { log.error({ err }, 'outbound audit reconciliation failed'); }
}, 10_000);
outboundAuditInterval.unref();
```

Add `clearInterval(outboundAuditInterval)` before runtime shutdown.

- [ ] **Step 4: Document, verify, and commit**

```markdown
### Transport delivery versus audit finalization
After transport returns a receipt, audit failure creates a content-free
`outbound_audit_reconciliation` row. The caller still receives success and
health remains degraded until reconciliation marks the audit row sent.
Reconciliation never invokes transport and therefore cannot duplicate delivery.
```

Run the chosen health test, `tests/core/send-pipeline.test.ts`, `tests/core/outbound-sends.test.ts`, and `typecheck:all`. Expected: PASS before and after one bounded reconciliation.

```bash
git add src/core/health.ts src/main.ts tests/core/health.test.ts docs/durability.md
git commit -m "fix(observability): surface pending delivery audits"
```

### Task 4: Define stable identity and ambiguity (WS-A05, commit 1)

**Files:**
- Create: `src/core/delivery-identity.ts`, `tests/core/delivery-identity.test.ts`
- Modify: `src/core/types.ts:19-52`, Baileys/Twilio implementations and Twilio tests.

**Interfaces:**
- Produces: `createStableMessageId`, `isAmbiguousDeliveryFailure`, and optional `deliveryIdempotency?: 'message_id' | 'none'` (absence fails closed as `none`).

- [ ] **Step 1: Write the failing helper test**

```ts
import { describe, expect, it } from 'vitest';
import { WhatSoupError } from '../../src/errors.ts';
import { SendAmbiguousError } from '../../src/transport/contract/errors.ts';
import { createStableMessageId, isAmbiguousDeliveryFailure } from '../../src/core/delivery-identity.ts';

describe('delivery identity', () => {
  it('creates uppercase 32-hex IDs', () => {
    expect(createStableMessageId(() => '123e4567-e89b-12d3-a456-426614174000'))
      .toBe('123E4567E89B12D3A456426614174000');
  });
  it('classifies only uncertain post-handoff outcomes as ambiguous', () => {
    expect(isAmbiguousDeliveryFailure(new WhatSoupError('timeout', 'SEND_TIMEOUT'))).toBe(true);
    expect(isAmbiguousDeliveryFailure(new WhatSoupError('unknown', 'SEND_UNCERTAIN'))).toBe(true);
    expect(isAmbiguousDeliveryFailure(new SendAmbiguousError({
      channelId: 'sms', operation: 'sendText', correlationId: 'c', scope: 'request',
      message: 'unknown', phase: 'provider_call_started',
    }))).toBe(true);
    expect(isAmbiguousDeliveryFailure(
      new WhatSoupError('not connected', 'CONNECTION_UNAVAILABLE'),
    )).toBe(false);
  });
});
```

- [ ] **Step 2: Verify red and implement helper**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/delivery-identity.test.ts --pool=forks`

Expected: FAIL because the module is absent.

```ts
import { randomUUID } from 'node:crypto';
import { WhatSoupError } from '../errors.ts';
import { SendAmbiguousError } from '../transport/contract/errors.ts';

export function createStableMessageId(randomUuid: () => string = randomUUID): string {
  return randomUuid().replace(/-/g, '').toUpperCase();
}
export function isAmbiguousDeliveryFailure(err: unknown): boolean {
  if (err instanceof WhatSoupError) return err.code === 'SEND_TIMEOUT' || err.code === 'SEND_UNCERTAIN';
  if (err instanceof SendAmbiguousError) return true;
  const payload = err && typeof err === 'object'
    ? (err as { payload?: { code?: unknown; phase?: unknown } }).payload : undefined;
  return payload?.code === 'transport.send_ambiguous' || payload?.phase === 'provider_call_started';
}
```

- [ ] **Step 3: Declare capability and correct Twilio classification**

Add to `Messenger`:

```ts
readonly deliveryIdempotency?: 'message_id' | 'none';
```

Use `readonly deliveryIdempotency = 'message_id' as const` for Baileys and truthful in-memory dedup fakes; use `'none'` for Twilio. Existing minimal test fakes may omit the optional field, which is deliberately interpreted as non-idempotent.

In `src/transport/twilio/adapter.ts`, import `SendAmbiguousError` and replace the transient branch:

```ts
if (isTwilioTransient(pe)) {
  if (operation === 'sendText') {
    return new SendAmbiguousError({
      ...base, message: `Twilio send outcome unknown: ${msg}`,
      providerCode: String(pe.code ?? pe.status ?? ''),
      phase: 'provider_call_started',
    });
  }
  return new TransientProviderError({
    ...base, message: `Twilio transient error: ${msg}`,
    providerCode: String(pe.code ?? pe.status ?? ''),
  });
}
```

Update `tests/transport/twilio/adapter-send.test.ts` to assert `sendText` network failure is `SendAmbiguousError` with phase `provider_call_started`; retain transient assertions for connect/voice/poll.

- [ ] **Step 4: Verify and commit**

Run the delivery helper, transport contract, Twilio adapter/bridge tests, then `typecheck:all`. Expected: PASS.

```bash
git add src/core/delivery-identity.ts src/core/types.ts src/transport/connection.ts src/transport/twilio/connection-bridge.ts src/transport/twilio/adapter.ts tests/core/delivery-identity.test.ts tests/transport/twilio/adapter-send.test.ts
git commit -m "feat(send): define stable delivery identity"
```

### Task 5: Reuse one ChatRuntime retry identity (WS-A05, commit 2)

**Files:**
- Modify: `src/runtimes/chat/runtime.ts:469-517`, its tests, agent outbound queue/idempotency test.

**Interfaces:**
- Consumes: Task 4 helpers/capability.
- Produces: one ID per logical WhatsApp response and no non-idempotent ambiguous retry.

- [ ] **Step 1: Write failing retry tests**

```ts
it('reuses one messageId across a logical WhatsApp reply retry', async () => {
  vi.useFakeTimers();
  const { handler, messenger } = makeHandler();
  messenger.deliveryIdempotency = 'message_id';
  messenger.sendMessage
    .mockRejectedValueOnce(new WhatSoupError('timeout', 'SEND_TIMEOUT'))
    .mockResolvedValueOnce({ waMessageId: 'wamid.same' });
  await handler.handleMessage(makeIncomingMessage());
  await vi.runAllTimersAsync();
  await drainQueue();
  const calls = messenger.sendMessage.mock.calls.filter((c: unknown[]) => c[1] === 'hey whats up');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[2]).toMatchObject({ messageId: expect.any(String) });
  expect(calls[1]?.[2]).toEqual(calls[0]?.[2]);
});

it('does not retry ambiguous delivery without idempotency', async () => {
  vi.useFakeTimers();
  const { handler, messenger } = makeHandler();
  messenger.deliveryIdempotency = 'none';
  messenger.sendMessage.mockRejectedValueOnce(new SendAmbiguousError({
    channelId: 'sms', operation: 'sendText', correlationId: 'c', scope: 'request',
    message: 'maybe accepted', phase: 'provider_call_started',
  }));
  await handler.handleMessage(makeIncomingMessage());
  await vi.runAllTimersAsync();
  await drainQueue();
  expect(messenger.sendMessage.mock.calls.filter((c: unknown[]) => c[1] === 'hey whats up'))
    .toHaveLength(1);
});
```

- [ ] **Step 2: Verify red and implement**

Expected current failure: ChatRuntime sends two arguments and retries every failure.

Import Task 4 helpers, then add before the send loop:

```ts
const stableMessageId = createStableMessageId();
const canRetryAmbiguous = this.messenger.deliveryIdempotency === 'message_id';
```

Replace the send and catch:

```ts
const receipt = canRetryAmbiguous
  ? await this.messenger.sendMessage(msg.chatJid, responseText, { messageId: stableMessageId })
  : await this.messenger.sendMessage(msg.chatJid, responseText);
```

```ts
} catch (err) {
  lastSendErr = err;
  if (isAmbiguousDeliveryFailure(err) && !canRetryAmbiguous) break;
}
```

Keep `markMaybeSent` and the uncertainty notice. In agent `OutboundQueue`, replace its inline UUID transformation with `createStableMessageId()`.

- [ ] **Step 3: Verify and commit**

Run chat runtime, agent outbound queue/idempotency, delivery helper tests, and `typecheck:all`. Expected: PASS for same logical ID, distinct later ID, and one non-idempotent ambiguous attempt.

```bash
git add src/runtimes/chat/runtime.ts src/runtimes/agent/outbound-queue.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts
git commit -m "fix(chat): reuse delivery identity across retries"
```

### Task 6: Persist scheduled-text identity (WS-A05, commit 3)

**Files:**
- Modify: `src/core/database.ts`, `src/core/scheduler.ts`, runtime transport interfaces/implementations, focused tests, `docs/configuration.md`.
- Create: `tests/core/migration-40-scheduled-delivery-identity.test.ts`.

**Interfaces:**
- Produces: `scheduled_messages.delivery_message_id`; `sendRaw(..., opts?: Pick<SendOptions,'messageId'>)`.

- [ ] **Step 1: Write migration and semantic retry tests**

```ts
// tests/core/migration-40-scheduled-delivery-identity.test.ts
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

describe('migration 40', () => {
  it('adds nullable scheduled delivery identity', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(40);
      expect((db.raw.prepare("PRAGMA table_info('scheduled_messages')").all() as
        Array<{ name: string }>).map((c) => c.name)).toContain('delivery_message_id');
    } finally { db.close(); }
  });
});
```

Append to `tests/core/scheduler.test.ts`:

```ts
it('reuses persisted identity on a later scheduled-text tick', async () => {
  const seen: string[] = [];
  let attempt = 0;
  const connection = {
    deliveryIdempotency: 'message_id' as const,
    sendRaw: vi.fn(async (_jid: string, _body: object, opts?: { messageId?: string }) => {
      seen.push(opts?.messageId ?? '');
      if (++attempt === 1) throw new Error('pre-ack failure');
      return { waMessageId: opts?.messageId ?? null };
    }), sendMedia: vi.fn(),
  };
  const id = insertScheduledMessage(db.raw);
  const scheduler = new MessageScheduler(db, connection as ConnectionManager,
    { intervalMs: 60_000, maxRetries: 3 });
  await scheduler.tick(); await scheduler.tick();
  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatch(/^[A-F0-9]{32}$/);
  expect(seen[1]).toBe(seen[0]);
  expect(db.raw.prepare(
    'SELECT status, delivery_message_id FROM scheduled_messages WHERE id=?',
  ).get(id)).toEqual({ status: 'sent', delivery_message_id: seen[0] });
});

it('quarantines ambiguous scheduled send without idempotency', async () => {
  const connection = {
    deliveryIdempotency: 'none' as const,
    sendRaw: vi.fn(async () => { throw new SendAmbiguousError({
      channelId: 'sms', operation: 'sendText', correlationId: 'c', scope: 'request',
      message: 'maybe accepted', phase: 'provider_call_started',
    }); }), sendMedia: vi.fn(),
  };
  const id = insertScheduledMessage(db.raw);
  const scheduler = new MessageScheduler(db, connection as ConnectionManager,
    { intervalMs: 60_000, maxRetries: 3 });
  await scheduler.tick(); await scheduler.tick();
  expect(connection.sendRaw).toHaveBeenCalledOnce();
  expect(db.raw.prepare(
    'SELECT status, retry_count, error FROM scheduled_messages WHERE id=?',
  ).get(id)).toEqual({
    status: 'failed', retry_count: 0,
    error: 'maybe_sent: manual verification required before retry',
  });
});
```

- [ ] **Step 2: Verify red and implement migration 40**

Expected: FAIL because column/options are absent.

```ts
function runMigration40(db: DatabaseSync): void {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_messages'",
  ).get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info('scheduled_messages')").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'delivery_message_id')) {
    db.exec('ALTER TABLE scheduled_messages ADD COLUMN delivery_message_id TEXT');
  }
}
```

Add `[40, runMigration40]` after `[39, runMigration39]` and:

```markdown
| 40 | Adds `scheduled_messages.delivery_message_id`; retries preserve it and each completed recurring occurrence clears it. |
```

- [ ] **Step 3: Extend and implement `sendRaw` identity**

In `RuntimeConnection`:

```ts
sendRaw(chatJid: string, content: Record<string, unknown>,
  opts?: Pick<SendOptions, 'messageId'>): Promise<SubmissionReceipt>;
```

In `ConnectionManager.sendRaw`, accept `opts` and use:

```ts
opts?.messageId
  ? this.sock.sendMessage(chatJid, content as any, { messageId: opts.messageId })
  : this.sock.sendMessage(chatJid, content as any)
```

Twilio `sendRaw` accepts but ignores `_opts` and still rejects unsupported raw sends.

- [ ] **Step 4: Claim/persist and use scheduler identity**

Add `delivery_message_id: string` to `ScheduledRow` and both SELECTs. Replace bulk claim with:

```ts
const claim = this.db.raw.prepare(`
  UPDATE scheduled_messages SET status='processing',
    delivery_message_id=COALESCE(delivery_message_id, ?)
  WHERE id=? AND status='pending'
`);
for (const candidate of candidates) claim.run(createStableMessageId(), candidate.id);
```

For text:

```ts
if (this.connection.deliveryIdempotency === 'message_id') {
  await this.connection.sendRaw(row.chat_jid, payload,
    { messageId: row.delivery_message_id });
} else { await this.connection.sendRaw(row.chat_jid, payload); }
```

At the start of the row catch:

```ts
if (isAmbiguousDeliveryFailure(err) && this.connection.deliveryIdempotency === 'none') {
  this.db.raw.prepare(`
    UPDATE scheduled_messages SET status='failed',
      error='maybe_sent: manual verification required before retry',
      send_started_at=NULL WHERE id=?
  `).run(row.id);
  continue;
}
```

Set `delivery_message_id=NULL` in recurring-success, recurring-retry-exhaustion skip, and recurring crash-skip UPDATEs. Preserve it for ordinary pending retry and one-shot sent/failed evidence.

- [ ] **Step 5: Verify and commit**

Run migration 40, scheduler, Baileys raw-send, Twilio bridge, delivery helper tests, then `typecheck:all`. Expected: PASS with one ID across ticks and one non-idempotent ambiguous provider call.

```bash
git add src/core/database.ts src/core/scheduler.ts src/transport/runtime-connection.ts src/transport/connection.ts src/transport/twilio/connection-bridge.ts tests/core/migration-40-scheduled-delivery-identity.test.ts tests/core/scheduler.test.ts tests/transport/connection-branches.test.ts docs/configuration.md
git commit -m "fix(scheduler): persist delivery identity across retries"
```

### Task 7: Document exceptions and run final verification

**Files:**
- Modify: `docs/durability.md`, `docs/runbooks/twilio-transport.md`
- Verify only elsewhere.

**Interfaces:**
- Produces: behavior matrix and two PR receipts.

- [ ] **Step 1: Add the exact behavior matrix**

```markdown
| Send path | Idempotency | Ambiguous outcome |
|---|---|---|
| Baileys text/raw | one client `messageId` per logical send | bounded retry with same ID |
| Twilio SMS | none declared | `maybe_sent`; manual verification; no automatic retry |
| Scheduled media | no stable media identity | no blind retry after structured ambiguity |
| Audit reconciliation | no transport call | retry audit finalization only |
```

Document in the Twilio runbook that a post-handoff network failure is `SendAmbiguousError` and requires provider-SID/log verification before manual resend.

- [ ] **Step 2: Run WS-A04 focused verification**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-39-outbound-audit-reconciliation.test.ts tests/core/outbound-sends.test.ts tests/core/send-pipeline.test.ts tests/core/health.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:lint:src
```

Expected: exit 0 and exactly one transport invocation in the audit-fault probe.

- [ ] **Step 3: Run WS-A05 focused verification**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/delivery-identity.test.ts tests/core/migration-40-scheduled-delivery-identity.test.ts tests/core/scheduler.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/outbound-queue-idempotency.test.ts tests/transport/connection-branches.test.ts tests/transport/twilio/adapter-send.test.ts tests/transport/twilio/connection-bridge.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: exit 0; same logical send/same ID, different send/different ID, and one attempt for non-idempotent ambiguity.

- [ ] **Step 4: Run the full release gate**

Run: `bash scripts/run-with-pinned-npm.sh run verify:release`

Expected: exit 0. Missing browsers, skipped external transcription, masked subprocess failures, or unavailable ARC sibling verification are explicit gaps.

- [ ] **Step 5: Record but do not execute live drills without approval**

```text
1. Real receipt + injected audit-finalization fault: caller success, degraded health, zero resend, then reconciliation.
2. Slow Baileys send: retry same ID and observe one visible message.
3. Restart between scheduled attempts: persisted ID reused.
4. Twilio post-handoff fault: one provider call and manual-verification state.
5. Two recurring occurrences: distinct IDs.
```

- [ ] **Step 6: Commit documentation**

```bash
git add docs/durability.md docs/runbooks/twilio-transport.md
git commit -m "docs(send): define retry identity and ambiguity"
```

## Self-Review Notes

- **Spec coverage:** Tasks 1-3 cover WS-A04 receipt truth, content-free repair, health, and reconciliation. Tasks 4-6 cover WS-A05 shared identity, chat/agent, scheduler persistence, and transport exceptions. Task 7 covers focused/full proof.
- **No-placeholder scan:** No deferred implementation instruction remains; every mutation step includes exact TypeScript, SQL, Markdown, or replacement behavior.
- **Type consistency:** Capability is optional `'message_id' | 'none'` with absence interpreted as `none`; all retry paths use `createStableMessageId`; raw-send options are `Pick<SendOptions, 'messageId'>` end to end.
- **Migration dependency:** 39/40 assume the durable-inbound train owns 37/38. If landing order changes, reserve fresh numbers and update schema tests/docs atomically.
- **Residual uncertainty:** Health coverage uses the exact existing `tests/core/health.test.ts` helpers `makeDb`, `makeDeps`, `buildTestServer`, and `httpReq`. Twilio exposes no provider idempotency key, Baileys dedup needs staging confirmation, and scheduled media intentionally remains outside stable text identity.
