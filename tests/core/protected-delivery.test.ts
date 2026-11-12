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
// The fragment key is the secret part of the link; the delivery id beside it is public.
const DELIVERY_LINK_KEY = 'c'.repeat(43);
const DELIVERY_LINK = `https://${TEST_LINK_HOST}/s/#v3.${DELIVERY_ID}.${DELIVERY_LINK_KEY}`;
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
    const durable = JSON.stringify(db.raw.prepare('SELECT * FROM protected_deliveries').all());
    expect(durable).not.toContain('managed.example');
    expect(durable).not.toContain(DELIVERY_LINK);
    expect(durable).not.toContain(DELIVERY_LINK_KEY);
    expect(durable).not.toContain(TEST_LINK_HOST);
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
    expect(durable).not.toContain(DELIVERY_LINK_KEY);
  });

  it('treats a missing transport acknowledgement as ambiguous instead of submitted', async () => {
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { return { waMessageId: null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'device-null-ack', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('transport outcome is ambiguous');
    expect(db.raw.prepare(`
      SELECT state, whatsapp_message_id, send_claim_token, send_claimed_at
      FROM protected_deliveries WHERE delivery_ref=?
    `).get(DELIVERY_REF)).toEqual({
      state: 'ambiguous', whatsapp_message_id: 'stable-id', send_claim_token: null, send_claimed_at: null,
    });
    expect(db.raw.prepare('SELECT outcome_code FROM outbound_sends').get()).toEqual({ outcome_code: 'ambiguous' });
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

  it('terminalizes expired uncertain rows without replaying and preserves a receipt on an active lease', async () => {
    let resolves = 0;
    let sends = 0;
    const now = new Date('2026-10-29T12:00:00.000Z');
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { throw new Error('not used'); },
      async resolve() { resolves += 1; throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { sends += 1; return { waMessageId: 'unused' }; } },
      now: () => now, randomId: () => 'stable-id',
    });
    const insert = db.raw.prepare(`
      INSERT INTO protected_deliveries (
        stage_operation_id, resolve_operation_id, delivery_ref, delivery_id,
        principal, recipient_jid, kind, device_id, purpose, whatsapp_message_id,
        state, expires_at, issued_at, attempt_count, send_claim_token, send_claimed_at
      ) VALUES (?, ?, ?, ?, '15551234567', '15551234567@s.whatsapp.net', 'rustdesk', 'fixture-device', 'login', ?, ?, ?, ?, 1, ?, ?)
    `);
    for (const state of ['staging', 'staged', 'resolving', 'failed', 'ambiguous']) {
      insert.run(
        `stage-${state}`, `resolve-${state}`, `delivery-${state}`, `id-${state}`, `message-${state}`, state,
        '2026-10-29T11:59:00.000Z', '2026-10-29T11:50:00.000Z', `lease-${state}`, '2026-10-29T11:58:00.000Z',
      );
    }
    insert.run(
      'stage-active', 'resolve-active', 'delivery-active', 'id-active', 'message-active', 'resolving',
      '2026-10-29T11:59:00.000Z', '2026-10-29T11:50:00.000Z', 'active-lease', '2026-10-29T11:59:30.000Z',
    );
    for (const state of ['delivered', 'read']) {
      insert.run(
        `stage-${state}`, `resolve-${state}`, `delivery-${state}`, `id-${state}`, `message-${state}`, state,
        '2026-10-29T11:59:00.000Z', '2026-10-29T11:50:00.000Z', null, null,
      );
    }

    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 0, skipped: 0 });
    expect(db.raw.prepare(`
      SELECT state, send_claim_token, send_claimed_at, terminal_at
      FROM protected_deliveries WHERE delivery_ref='delivery-active'
    `).get()).toEqual({ state: 'resolving', send_claim_token: 'active-lease', send_claimed_at: '2026-10-29T11:59:30.000Z', terminal_at: null });
    await expect(service.recordReceipt({
      whatsappMessageId: 'message-active', recipientJid: '15551234567@s.whatsapp.net', type: 'read',
    })).resolves.toBe(true);
    expect(db.raw.prepare(`
      SELECT state, send_claim_token, send_claimed_at
      FROM protected_deliveries WHERE delivery_ref='delivery-active'
    `).get()).toEqual({ state: 'read', send_claim_token: null, send_claimed_at: null });
    expect(db.raw.prepare(`
      SELECT state, send_claim_token, send_claimed_at, terminal_at
      FROM protected_deliveries
      WHERE delivery_ref LIKE 'delivery-%'
        AND delivery_ref NOT IN ('delivery-active', 'delivery-delivered', 'delivery-read')
      ORDER BY delivery_ref
    `).all()).toEqual([
      'ambiguous', 'failed', 'resolving', 'staged', 'staging',
    ].map(() => expect.objectContaining({ state: 'expired', send_claim_token: null, send_claimed_at: null, terminal_at: expect.any(String) })));
    await expect(service.recordReceipt({
      whatsappMessageId: 'message-resolving', recipientJid: '15551234567@s.whatsapp.net', type: 'delivery',
    })).resolves.toBe(true);
    expect(db.raw.prepare(`
      SELECT state, send_claim_token, send_claimed_at
      FROM protected_deliveries WHERE delivery_ref='delivery-resolving'
    `).get()).toEqual({ state: 'delivered', send_claim_token: null, send_claimed_at: null });
    expect(db.raw.prepare(`
      SELECT delivery_ref, state FROM protected_deliveries
      WHERE delivery_ref IN ('delivery-delivered', 'delivery-read') ORDER BY delivery_ref
    `).all()).toEqual([
      { delivery_ref: 'delivery-delivered', state: 'delivered' },
      { delivery_ref: 'delivery-read', state: 'read' },
    ]);
    expect(resolves).toBe(0);
    expect(sends).toBe(0);
  });

  it('does not expire an actively resolving send before its stable acknowledgement arrives', async () => {
    let now = new Date('2026-10-29T11:59:00.000Z');
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
      now: () => now, randomId: () => 'stable-id',
    });
    await service.requestRustdesk({ deviceId: 'device-in-flight', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    const delivery = service.deliver({ deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    await Promise.resolve();
    now = new Date('2026-10-29T11:59:30.000Z');
    db.raw.prepare('UPDATE protected_deliveries SET expires_at=? WHERE delivery_ref=?')
      .run('2026-10-29T11:59:15.000Z', DELIVERY_REF);

    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 0, skipped: 0 });
    expect(db.raw.prepare('SELECT state, send_claim_token FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF))
      .toEqual({ state: 'resolving', send_claim_token: 'stable-id' });
    releaseResolve?.();
    await expect(delivery).resolves.toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
    expect(sends).toBe(1);
    expect(db.raw.prepare('SELECT state FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF)).toEqual({ state: 'submitted' });
  });

  describe('a link that expires while its send is still pending', () => {
    const principal = '15551234567';
    const recipientJid = '15551234567@s.whatsapp.net';
    const request = { deviceId: 'device-pending-send', purpose: 'login' as const, principal, recipientJid };

    function pendingSendHarness(start: string) {
      let now = new Date(start);
      let n = 0;
      const counts = { stages: 0, resolves: 0, sends: 0 };
      let releaseSend: (() => void) | undefined;
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
      let markSendStarted: (() => void) | undefined;
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
      const client: ManagedDeliveryClient = {
        async stageRustdesk() {
          counts.stages += 1;
          return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' };
        },
        async resolve() {
          counts.resolves += 1;
          return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' };
        },
        async getStatus() {
          return managedStatus(now.getTime() >= Date.parse(EXPIRES_AT) ? { state: 'expired' } : {});
        },
        async reportEvent() {},
      };
      const service = new ProtectedDeliveryService({
        db: db.raw, client,
        messenger: {
          async sendRaw(_jid, _content, options) {
            counts.sends += 1;
            markSendStarted?.();
            await sendGate;
            return { waMessageId: options?.messageId ?? null };
          },
        },
        now: () => now,
        // Distinct ids so a replacement row could be inserted if the lease were lost.
        randomId: () => `opaque-${++n}`,
      });
      return {
        service, counts, sendStarted,
        release: () => releaseSend?.(),
        advance: (iso: string) => { now = new Date(iso); },
      };
    }

    async function expectOneIssuanceSettledAsSubmitted(
      harness: ReturnType<typeof pendingSendHarness>,
      first: Promise<{ deliveryRef: string; id: string; state: string }>,
    ): Promise<void> {
      await expect(harness.service.requestRustdeskAccess(request)).rejects.toThrow('outcome is still unresolved');
      harness.release();
      const settled = await first;
      expect(settled).toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
      expect(db.raw.prepare('SELECT state, send_claim_token FROM protected_deliveries').all())
        .toEqual([{ state: settled.state, send_claim_token: null }]);
      expect(harness.counts).toEqual({ stages: 1, resolves: 1, sends: 1 });
    }

    it('keeps the send lease when status polling reports the grant expired', async () => {
      const harness = pendingSendHarness('2026-10-29T12:04:30.000Z');
      const first = harness.service.requestRustdeskAccess(request);
      await harness.sendStarted;
      // Past the link deadline, but the 12:04:30 send lease is still inside its retry window.
      harness.advance('2026-10-29T12:05:10.000Z');

      await expect(harness.service.status({ deliveryId: DELIVERY_ID, principal })).resolves
        .toMatchObject({ id: DELIVERY_ID, state: 'expired' });
      expect(db.raw.prepare('SELECT state, send_claim_token FROM protected_deliveries').get())
        .toEqual({ state: 'resolving', send_claim_token: expect.any(String) });

      await expectOneIssuanceSettledAsSubmitted(harness, first);
    });

    it('keeps the send lease when a second deliver call arrives after the link deadline', async () => {
      const harness = pendingSendHarness('2026-10-29T12:04:30.000Z');
      const first = harness.service.requestRustdeskAccess(request);
      await harness.sendStarted;
      harness.advance('2026-10-29T12:05:10.000Z');

      await expect(harness.service.deliver({ deliveryRef: DELIVERY_REF, principal, recipientJid }))
        .rejects.toThrow('already being sent');

      await expectOneIssuanceSettledAsSubmitted(harness, first);
    });

    it('keeps a retry send lease when the retry window elapses before it settles', async () => {
      let now = new Date('2026-10-29T12:00:00.000Z');
      let sends = 0;
      let releaseSend: (() => void) | undefined;
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
      let markSendStarted: (() => void) | undefined;
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
      let n = 0;
      const service = new ProtectedDeliveryService({
        db: db.raw,
        client: {
          async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
          async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
          async getStatus() { return managedStatus(); },
          async reportEvent() {},
        },
        messenger: {
          async sendRaw(_jid, _content, options) {
            sends += 1;
            if (sends === 1) throw new Error('transport unavailable');
            markSendStarted?.();
            await sendGate;
            return { waMessageId: options?.messageId ?? null };
          },
        },
        now: () => now,
        randomId: () => `opaque-${++n}`,
      });
      await service.requestRustdesk(request);
      await expect(service.deliver({ deliveryRef: DELIVERY_REF, principal, recipientJid }))
        .rejects.toThrow('transport outcome is ambiguous');

      now = new Date('2026-10-29T12:00:50.000Z');
      const retry = service.deliver({ deliveryRef: DELIVERY_REF, principal, recipientJid });
      await sendStarted;
      // The first attempt's retry window closed at 12:01:00; the 12:00:50 lease is 20 s old.
      now = new Date('2026-10-29T12:01:10.000Z');

      await expect(service.deliver({ deliveryRef: DELIVERY_REF, principal, recipientJid }))
        .rejects.toThrow('already being sent');
      releaseSend?.();
      const settled = await retry;
      expect(settled).toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
      expect(db.raw.prepare('SELECT state, send_claim_token FROM protected_deliveries').get())
        .toEqual({ state: settled.state, send_claim_token: null });
      expect(sends).toBe(2);
    });

    it('keeps a fresh send or staging lease at the retry limit instead of failing it', async () => {
      const now = new Date('2026-10-29T12:00:30.000Z');
      let stages = 0;
      const service = new ProtectedDeliveryService({
        db: db.raw,
        client: {
          async stageRustdesk() { stages += 1; throw new Error('not used'); },
          async resolve() { throw new Error('not used'); },
          async getStatus() { return managedStatus(); },
          async reportEvent() {},
        },
        messenger: { async sendRaw() { throw new Error('not used'); } },
        now: () => now,
        randomId: () => 'unused-id',
      });
      const insert = db.raw.prepare(`
        INSERT INTO protected_deliveries (
          stage_operation_id, resolve_operation_id, delivery_ref, delivery_id,
          principal, recipient_jid, kind, device_id, purpose, whatsapp_message_id,
          state, expires_at, issued_at, first_attempt_at, attempt_count, send_claim_token, send_claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'rustdesk', ?, 'login', ?, ?, ?, ?, ?, 3, ?, ?)
      `);
      insert.run(
        'stage-sending', 'resolve-sending', DELIVERY_REF, DELIVERY_ID, principal, recipientJid, 'device-sending', 'message-sending',
        'resolving', EXPIRES_AT, '2026-10-29T12:00:00.000Z', '2026-10-29T12:00:00.000Z', 'send-lease', '2026-10-29T12:00:20.000Z',
      );
      insert.run(
        'stage-staging', 'resolve-staging', null, null, principal, recipientJid, 'device-staging', 'message-staging',
        'staging', EXPIRES_AT, '2026-10-29T12:00:00.000Z', '2026-10-29T12:00:00.000Z', 'stage-lease', '2026-10-29T12:00:20.000Z',
      );

      await expect(service.deliver({ deliveryRef: DELIVERY_REF, principal, recipientJid }))
        .rejects.toThrow('already being sent');
      await expect(service.requestRustdesk({ deviceId: 'device-staging', purpose: 'login', principal, recipientJid }))
        .rejects.toThrow('already being staged');

      expect(stages).toBe(0);
      expect(db.raw.prepare('SELECT state, send_claim_token, terminal_at FROM protected_deliveries ORDER BY id').all())
        .toEqual([
          { state: 'resolving', send_claim_token: 'send-lease', terminal_at: null },
          { state: 'staging', send_claim_token: 'stage-lease', terminal_at: null },
        ]);
    });
  });

  it('does not reuse a newer row while an expired staging lease is active under another alias', async () => {
    let stageCalls = 0;
    const now = new Date('2026-10-29T12:00:00.000Z');
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { stageCalls += 1; return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { throw new Error('not used'); } },
      now: () => now, randomId: () => 'stable-id',
    });
    db.raw.prepare(`
      INSERT INTO protected_deliveries (
        stage_operation_id, resolve_operation_id, delivery_ref, delivery_id,
        principal, recipient_jid, kind, device_id, purpose, whatsapp_message_id,
        state, expires_at, issued_at, attempt_count, send_claim_token, send_claimed_at
      ) VALUES (
        'active-request-stage', 'active-request-resolve', 'active-request-ref', 'active-request-id',
        '15551234567', '11111112345@lid', 'rustdesk', 'device-active-request', 'login', 'active-request-message',
        'staging', '2026-10-29T11:59:00.000Z', '2026-10-29T11:50:00.000Z', 1, 'active-request-lease', '2026-10-29T11:59:30.000Z'
      )
    `).run();
    db.raw.prepare(`
      INSERT INTO protected_deliveries (
        stage_operation_id, resolve_operation_id, delivery_ref, delivery_id,
        principal, recipient_jid, kind, device_id, purpose, whatsapp_message_id,
        state, expires_at, issued_at
      ) VALUES (
        'newer-request-stage', 'newer-request-resolve', 'newer-request-ref', 'newer-request-id',
        '15551234567', '15551234567@s.whatsapp.net', 'rustdesk', 'device-active-request', 'login', 'newer-request-message',
        'staged', '2026-10-29T12:05:00.000Z', '2026-10-29T11:59:45.000Z'
      )
    `).run();

    await expect(service.requestRustdesk({
      deviceId: 'device-active-request', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('outcome is still unresolved');
    expect(stageCalls).toBe(0);
    expect(db.raw.prepare('SELECT state, send_claim_token FROM protected_deliveries ORDER BY id').all())
      .toEqual([
        { state: 'staging', send_claim_token: 'active-request-lease' },
        { state: 'staged', send_claim_token: null },
      ]);
  });

  it('preserves a receipt that arrives while a transport acknowledgement is ambiguous', async () => {
    let releaseSend: (() => void) | undefined;
    const sending = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted = false;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: {
        async sendRaw() {
          sendStarted = true;
          await sending;
          return { waMessageId: null };
        },
      },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({ deviceId: 'device-receipt-race', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    const delivery = service.deliver({ deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net' });
    while (!sendStarted) await Promise.resolve();

    await expect(service.recordReceipt({
      whatsappMessageId: 'stable-id', recipientJid: '15551234567@s.whatsapp.net', type: 'read',
    })).resolves.toBe(true);
    releaseSend?.();
    await expect(delivery).rejects.toThrow('transport outcome is ambiguous');
    expect(db.raw.prepare('SELECT state FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF))
      .toEqual({ state: 'read' });
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

  it('recovers a verified legacy LID row through its canonical phone destination', async () => {
    const recipients: string[] = [];
    let stageCalls = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { stageCalls += 1; return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw(recipient, _content, options) { recipients.push(recipient); return { waMessageId: options?.messageId ?? null }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'legacy-lid', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    db.raw.prepare('UPDATE protected_deliveries SET recipient_jid=? WHERE delivery_ref=?')
      .run('11111112345@lid', DELIVERY_REF);
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111112345', '15551234567@s.whatsapp.net');

    await expect(service.requestRustdesk({
      deviceId: 'legacy-lid', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).resolves.toMatchObject({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID });
    expect(stageCalls).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM protected_deliveries').get()).toEqual({ count: 1 });

    await expect(service.recoverPendingDeliveries()).resolves.toEqual({ resumed: 1, skipped: 0 });
    expect(recipients).toEqual(['15551234567@s.whatsapp.net']);
    expect(db.raw.prepare('SELECT recipient_jid, whatsapp_message_id FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF))
      .toEqual({ recipient_jid: '15551234567@s.whatsapp.net', whatsapp_message_id: 'stable-id' });
  });

  it('does not reissue when a matching legacy LID row cannot be verified', async () => {
    let stageCalls = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { stageCalls += 1; return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { throw new Error('not used'); } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    const request = {
      deviceId: 'legacy-unresolved', purpose: 'login' as const, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    };
    await service.requestRustdesk(request);
    db.raw.prepare('UPDATE protected_deliveries SET recipient_jid=? WHERE delivery_ref=?')
      .run('11111112345@lid', DELIVERY_REF);
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111112345', '15550000000@s.whatsapp.net');

    await expect(service.requestRustdesk(request)).rejects.toThrow('recipient identity is unresolved');
    expect(stageCalls).toBe(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM protected_deliveries').get()).toEqual({ count: 1 });
  });

  it('does not retarget a verified legacy LID row after its outcome is ambiguous', async () => {
    let sends = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { sends += 1; return { waMessageId: 'stable-id' }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'legacy-ambiguous', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    db.raw.prepare(`UPDATE protected_deliveries SET recipient_jid='11111112345@lid',state='ambiguous'
      WHERE delivery_ref=?`).run(DELIVERY_REF);
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111112345', '15551234567@s.whatsapp.net');

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('recipient does not match');
    expect(sends).toBe(0);
    expect(db.raw.prepare('SELECT recipient_jid,state FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF))
      .toEqual({ recipient_jid: '11111112345@lid', state: 'ambiguous' });
  });

  it('does not rewrite a verified legacy LID row while another worker holds its send claim', async () => {
    let sends = 0;
    const client: ManagedDeliveryClient = {
      async stageRustdesk() { return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: EXPIRES_AT, state: 'unclaimed' }; },
      async resolve() { throw new Error('not used'); },
      async getStatus() { return managedStatus(); },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw, client,
      messenger: { async sendRaw() { sends += 1; return { waMessageId: 'stable-id' }; } },
      now: () => new Date('2026-10-29T12:00:00.000Z'), randomId: () => 'stable-id',
    });
    await service.requestRustdesk({
      deviceId: 'legacy-held', purpose: 'login', principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    });
    db.raw.prepare(`UPDATE protected_deliveries
      SET recipient_jid='11111112345@lid',send_claim_token='held-claim',send_claimed_at='2026-10-29T12:00:00.000Z'
      WHERE delivery_ref=?`).run(DELIVERY_REF);
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111112345', '15551234567@s.whatsapp.net');

    await expect(service.deliver({
      deliveryRef: DELIVERY_REF, principal: '15551234567', recipientJid: '15551234567@s.whatsapp.net',
    })).rejects.toThrow('recipient does not match');
    expect(sends).toBe(0);
    expect(db.raw.prepare('SELECT recipient_jid,send_claim_token FROM protected_deliveries WHERE delivery_ref=?').get(DELIVERY_REF))
      .toEqual({ recipient_jid: '11111112345@lid', send_claim_token: 'held-claim' });
  });
});
