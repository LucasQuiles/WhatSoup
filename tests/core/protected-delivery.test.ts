import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  ProtectedDeliveryService,
  type ManagedDeliveryClient,
} from '../../src/core/protected-delivery.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';

// Every service below runs with its production default pins, swapped for the
// neutral test pins.
vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));

const DELIVERY_REF = 'aaaaaaaaaaaaaaaaaaaaaa';
const DELIVERY_ID = 'bbbbbbbbbbbbbbbbbbbbbb';
const DELIVERY_LINK = `https://${TEST_LINK_HOST}/s/#v3.${DELIVERY_ID}.${'c'.repeat(43)}`;
const EXPIRES_AT = '2026-10-29T12:05:00.000Z';

function managedStatus(overrides: Partial<Awaited<ReturnType<ManagedDeliveryClient['getStatus']>>> = {}) {
  return {
    deliveryRef: DELIVERY_REF,
    id: DELIVERY_ID,
    state: 'unclaimed',
    deliveryStatus: 'staged',
    expiresAt: EXPIRES_AT,
    issuedAt: '2026-10-29T12:00:00.000Z',
    kind: 'rustdesk' as const,
    deviceId: 'device-1',
    purpose: 'login' as const,
    ...overrides,
  };
}

describe('protected delivery', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('persists an opaque operation before staging a RustDesk delivery', async () => {
    let persistedBeforeRemote = false;
    const client: ManagedDeliveryClient = {
      async stageRustdesk(request) {
        persistedBeforeRemote = db.raw.prepare(
          'SELECT 1 AS ok FROM protected_deliveries WHERE stage_operation_id = ?',
        ).get(request.operationId) !== undefined;
        return {
          deliveryRef: DELIVERY_REF,
          id: DELIVERY_ID,
          expiresAt: EXPIRES_AT,
          state: 'staged',
        };
      },
      async resolve() {
        return {
          id: DELIVERY_ID,
          link: DELIVERY_LINK,
          expiresAt: EXPIRES_AT,
          state: 'staged',
        };
      },
      async getStatus() {
        return managedStatus();
      },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw,
      client,
      messenger: { async sendRaw() { return { waMessageId: 'unused' }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: () => 'stable-id',
    });

    const staged = await service.requestRustdesk({
      deviceId: 'device-1', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });

    expect(persistedBeforeRemote).toBe(true);
    expect(staged).toEqual({
      deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'staged',
    });
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM protected_deliveries').all()))
      .not.toContain('managed.example');
  });

  it('sends a resolved link with its persisted WhatsApp id and retains no link body', async () => {
    const sent: Array<{ content: Record<string, unknown>; options?: { messageId?: string } }> = [];
    const client: ManagedDeliveryClient = {
      async stageRustdesk() {
        return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' };
      },
      async resolve() {
        return {
          id: DELIVERY_ID, link: DELIVERY_LINK,
          expiresAt: EXPIRES_AT, state: 'unclaimed',
        };
      },
      async getStatus() {
        return managedStatus();
      },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw,
      client,
      messenger: {
        async sendRaw(_recipient, content, options) {
          sent.push({ content, options });
          return { waMessageId: options?.messageId ?? null };
        },
      },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'device-2', purpose: 'recovery', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });

    const delivered = await service.deliver({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      recipientJid: '15551234567@s.whatsapp.net',
    });

    expect(delivered).toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
    expect(sent).toEqual([{
      content: { text: DELIVERY_LINK, linkPreview: null },
      options: { messageId: 'stable-id' },
    }]);
    const durable = JSON.stringify({
      deliveries: db.raw.prepare('SELECT * FROM protected_deliveries').all(),
      sends: db.raw.prepare('SELECT * FROM outbound_sends').all(),
    });
    expect(durable).not.toContain(TEST_LINK_HOST);
    expect(durable).not.toContain('c'.repeat(43));
  });

  it('deduplicates WhatsApp receipt events before relaying metadata', async () => {
    const reported: Array<{ eventId: string; status: string }> = [];
    const client: ManagedDeliveryClient = {
      async stageRustdesk() {
        return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' };
      },
      async resolve() {
        return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' };
      },
      async getStatus() {
        return managedStatus();
      },
      async reportEvent(event) { reported.push(event); },
    };
    const service = new ProtectedDeliveryService({
      db: db.raw,
      client,
      messenger: { async sendRaw(_recipient, _content, options) { return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'device-3', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    await service.deliver({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      recipientJid: '15551234567@s.whatsapp.net',
    });

    await service.recordReceipt({ whatsappMessageId: 'stable-id', recipientJid: '15551234567@s.whatsapp.net', type: 'delivery' });
    await service.recordReceipt({ whatsappMessageId: 'stable-id', recipientJid: '15551234567@s.whatsapp.net', type: 'delivery' });

    expect(reported.filter((event) => event.status === 'delivered')).toHaveLength(0);
    await expect(service.flushPendingEvents()).resolves.toEqual({ relayed: 2, pending: 0, failed: false });
    expect(reported.filter((event) => event.status === 'delivered')).toHaveLength(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM protected_delivery_events WHERE status = ?').get('delivered'))
      .toEqual({ n: 1 });
  });

  it('stops after one metadata relay failure and leaves the bounded batch pending', async () => {
    let attempts = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() {
        return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' };
      },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() { attempts += 1; throw new Error('network unavailable'); },
    };
    const service = new ProtectedDeliveryService({
      db: db.raw,
      client,
      messenger: { async sendRaw() { return { waMessageId: null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'device-4', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    db.raw.prepare(`INSERT INTO protected_delivery_events (event_id, delivery_ref, status, observed_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)`)
      .run(
        'event-one', DELIVERY_REF, 'submitted', '2026-10-29T12:00:00.000Z',
        'event-two', DELIVERY_REF, 'delivered', '2026-10-29T12:00:01.000Z',
      );

    await expect(service.flushPendingEvents()).resolves.toEqual({ relayed: 0, pending: 2, failed: true });
    expect(attempts).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM protected_delivery_events WHERE relayed_at IS NULL').get())
      .toEqual({ n: 2 });
  });

  it('adopts only an unclaimed staged remote delivery before resolving and sending it', async () => {
    let resolved = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { throw new Error('not used'); },
      async resolve() { resolved += 1; return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus({ kind: 'secret', deviceId: null, purpose: null }); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(_jid, _content, options) { return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).resolves.toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
    expect(resolved).toBe(1);
    expect(db.raw.prepare('SELECT kind,device_id,purpose FROM protected_deliveries').get())
      .toEqual({ kind: 'secret', device_id: null, purpose: null });
  });

  it('rejects claimed or terminal remote delivery metadata without resolving a replacement', async () => {
    let resolved = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { throw new Error('not used'); },
      async resolve() { resolved += 1; return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus({ state: 'claimed', deliveryStatus: 'read' }); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { return { waMessageId: null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('not available');
    expect(resolved).toBe(0);
  });

  it('atomically excludes a concurrent delivery while one resolution is in flight', async () => {
    let releaseResolve: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let sends = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { await blocked; return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(_jid, _content, options) { sends += 1; return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({ deviceId: 'device-1', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });

    const first = service.deliver({ deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    await Promise.resolve();
    await expect(service.deliver({ deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' }))
      .rejects.toThrow('already being sent');
    releaseResolve?.();
    await first;
    expect(sends).toBe(1);
  });

  it('keeps an ambiguous staged operation durable and bounded instead of minting another one', async () => {
    const operationIds: string[] = [];
    const client: ManagedDeliveryClient = {
      async stageRustdesk(request) { operationIds.push(request.operationId); throw new Error('network outcome unknown'); },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { return { waMessageId: null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    const request = { deviceId: 'device-1', purpose: 'login' as const, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' };

    await expect(service.requestRustdesk(request)).rejects.toThrow('staging failed');
    await expect(service.requestRustdesk(request)).rejects.toThrow('staging failed');
    await expect(service.requestRustdesk(request)).rejects.toThrow('staging failed');
    await expect(service.requestRustdesk(request)).rejects.toThrow('ambiguous');
    expect(operationIds).toEqual(['stable-id', 'stable-id', 'stable-id']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n,state FROM protected_deliveries').get())
      .toEqual({ n: 1, state: 'failed' });
  });

  it('returns grant state and delivery evidence without relaying events from the read-only status tool', async () => {
    let reports = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus({ state: 'claimed', deliveryStatus: 'submitted' }); },
      async reportEvent() { reports += 1; },
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(_jid, _content, options) { return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdeskAccess({ deviceId: 'device-1', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    await service.recordReceipt({ whatsappMessageId: 'stable-id', recipientJid: '15551234567@s.whatsapp.net', type: 'read' });
    const beforeStatus = reports;

    await expect(service.status({ deliveryId: DELIVERY_ID, principal: '15551234567' })).resolves.toEqual({
      id: DELIVERY_ID, state: 'claimed', deliveryStatus: 'read', expiresAt: EXPIRES_AT,
    });
    expect(reports).toBe(beforeStatus);
  });

  it('keeps a claimed RustDesk grant valid past its original unclaimed-link deadline', async () => {
    let now = new Date('2026-10-29T12:00:00.000Z');
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus({ state: 'claimed', deliveryStatus: 'submitted' }); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(_jid, _content, options) { return { waMessageId: options?.messageId ?? null }; } },
      now: () => now, randomId: () => 'stable-id',
    });
    await service.requestRustdeskAccess({ deviceId: 'device-1', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    now = new Date('2026-10-29T12:05:30.000Z');

    await expect(service.status({ deliveryId: DELIVERY_ID, principal: '15551234567' })).resolves.toEqual({
      id: DELIVERY_ID, state: 'claimed', deliveryStatus: 'submitted', expiresAt: EXPIRES_AT,
    });
  });

  it('does not auto-replay resolving or ambiguous delivery outcomes', async () => {
    let resolves = 0;
    let sends = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { resolves += 1; return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { sends += 1; return { waMessageId: 'stable-id' }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'device-5', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    db.raw.prepare(`UPDATE protected_deliveries
      SET state='resolving', attempt_count=1, send_claim_token='interrupted', send_claimed_at=?, updated_at=?
      WHERE delivery_ref=?`)
      .run('2026-10-29T12:00:00.000Z', '2026-10-29T12:00:00.000Z', DELIVERY_REF);

    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 0, skipped: 0 });
    db.raw.prepare(`UPDATE protected_deliveries
      SET state='ambiguous', send_claim_token=NULL, send_claimed_at=NULL, updated_at=?
      WHERE delivery_ref=?`)
      .run('2026-10-29T12:00:00.000Z', DELIVERY_REF);
    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 0, skipped: 0 });

    expect(resolves).toBe(0);
    expect(sends).toBe(0);
  });

  it('reuses the resolve operation and WhatsApp message IDs for an explicit bounded retry', async () => {
    const resolveOperationIds: string[] = [];
    const messageIds: Array<string | undefined> = [];
    const ids = ['stage-operation', 'resolve-operation', 'whatsapp-message', 'stage-claim', 'first-send-claim', 'retry-send-claim'];
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve(request) {
        resolveOperationIds.push(request.operationId);
        return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' };
      },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: {
        async sendRaw(_jid, _content, options) {
          messageIds.push(options?.messageId);
          if (messageIds.length === 1) throw new Error('transport unavailable');
          return { waMessageId: options?.messageId ?? null };
        },
      },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: () => {
        const id = ids.shift();
        if (!id) throw new Error('unexpected identifier generation');
        return id;
      },
    });
    await service.requestRustdesk({
      deviceId: 'device-6', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('transport outcome is ambiguous');
    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).resolves.toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });

    expect(resolveOperationIds).toEqual(['resolve-operation', 'resolve-operation']);
    expect(messageIds).toEqual(['whatsapp-message', 'whatsapp-message']);
  });

  it('recovers only an existing recent staged delivery and never mints a replacement', async () => {
    let sends = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(_jid, _content, options) { sends += 1; return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({ deviceId: 'device-1', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });

    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 1, skipped: 0 });
    expect(sends).toBe(1);
  });
});
