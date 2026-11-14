import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ProtectedDeliveryService, type ManagedDeliveryClient } from '../../../src/core/protected-delivery.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerProtectedDeliveryTools } from '../../../src/mcp/tools/protected-delivery.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { TEST_LINK_HOST, TEST_PROTECTED_DELIVERY_PINS } from '../../helpers/protected-delivery-pins.ts';

const DELIVERY_REF = 'aaaaaaaaaaaaaaaaaaaaaa';
const DELIVERY_ID = 'bbbbbbbbbbbbbbbbbbbbbb';
// The fragment key is the secret part of the link; the delivery id beside it is public.
const DELIVERY_LINK_KEY = 'c'.repeat(43);
const DELIVERY_LINK = `https://${TEST_LINK_HOST}/s/#v3.${DELIVERY_ID}.${DELIVERY_LINK_KEY}`;

function expectOpaqueSubmittedResponse(text: string): void {
  expect(text).not.toContain(DELIVERY_LINK);
  expect(text).not.toContain(DELIVERY_LINK_KEY);
  expect(text).not.toContain(TEST_LINK_HOST);
  expect(JSON.parse(text)).toEqual({ deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'submitted' });
}

const directSession: SessionContext = {
  tier: 'chat-scoped',
  actorJid: '15551234567@s.whatsapp.net',
  deliveryJid: '15551234567@s.whatsapp.net',
  conversationKey: '15551234567',
};

describe('protected delivery MCP tools', () => {
  let db: Database;
  let registry: ToolRegistry;
  let sends: string[];

  beforeEach(() => {
    sends = [];
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    const client: ManagedDeliveryClient = {
      async stageRustdesk() {
        return { deliveryRef: DELIVERY_REF, id: DELIVERY_ID, expiresAt: '2026-10-29T12:05:00.000Z', state: 'unclaimed' };
      },
      async resolve() {
        return { id: DELIVERY_ID, link: DELIVERY_LINK, expiresAt: '2026-10-29T12:05:00.000Z', state: 'unclaimed' };
      },
      async getStatus() {
        return {
          deliveryRef: DELIVERY_REF, id: DELIVERY_ID, state: 'unclaimed', deliveryStatus: 'staged',
          expiresAt: '2026-10-29T12:05:00.000Z', issuedAt: '2026-10-29T12:00:00.000Z',
          kind: 'rustdesk' as const, deviceId: 'device-1', purpose: 'login' as const,
        };
      },
      async reportEvent() {},
    };
    const service = new ProtectedDeliveryService({
      db: db.raw,
      client,
      messenger: {
        async sendRaw(recipient, _content, options) {
          sends.push(recipient);
          return { waMessageId: options?.messageId ?? null };
        },
      },
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      randomId: (() => {
        let n = 0;
        return () => `opaque-${++n}`;
      })(),
      pins: TEST_PROTECTED_DELIVERY_PINS,
    });
    registerProtectedDeliveryTools(registry, { db, service });
  });

  afterEach(() => db.close());

  it('exposes only opaque inputs and results to a direct DM', async () => {
    const names = registry.listTools(directSession).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'request_rustdesk_access', 'deliver_secret', 'get_secret_delivery_status',
    ]));

    const staged = await registry.call('request_rustdesk_access', {
      device_id: 'device-1', purpose: 'login',
    }, directSession);
    const body = staged.content[0].text;
    expect(body).toContain(DELIVERY_REF);
    expect(body).not.toContain(TEST_LINK_HOST);
    expect(body).not.toContain('fragment');
    // request_rustdesk_access stages and sends, so it already reports the submitted delivery.
    expectOpaqueSubmittedResponse(body);

    const delivered = await registry.call('deliver_secret', { delivery_ref: DELIVERY_REF }, directSession);
    expect(delivered.content[0].text).toContain('submitted');
    expect(delivered.content[0].text).not.toContain('managed.example');
    expectOpaqueSubmittedResponse(delivered.content[0].text);
  });

  it('refuses a group or a direct identity that differs from the recipient', async () => {
    const group = await registry.call('request_rustdesk_access', {
      device_id: 'device-1', purpose: 'login',
    }, {
      ...directSession,
      actorJid: '15551234567@s.whatsapp.net',
      deliveryJid: '12345@g.us',
      conversationKey: '12345_at_g.us',
    });
    const mismatched = await registry.call('request_rustdesk_access', {
      device_id: 'device-1', purpose: 'login',
    }, {
      ...directSession,
      deliveryJid: '15557654321@s.whatsapp.net',
      conversationKey: '15557654321',
    });
    const nonWhatsApp = await registry.call('request_rustdesk_access', {
      device_id: 'device-1', purpose: 'login',
    }, {
      ...directSession,
      actorJid: '15551234567@sms',
      deliveryJid: '15551234567@sms',
    });

    expect(group.isError).toBe(true);
    expect(mismatched.isError).toBe(true);
    expect(nonWhatsApp.isError).toBe(true);
  });

  const socketAttribution = (tokenResult: 'match' | 'absent') => ({
    transport: 'socket' as const, connectionId: 'test-connection', tokenResult, clientName: null, clientVersion: null,
  });

  // Parity with send_message: a refused session token never stages, sends or reads a delivery; neither does a
  // presented, matched token whose binding has since been revoked.
  it.each([
    ['refused on another socket', { sessionTokenRefusal: 'wrong_socket' as const }],
    ['revoked', { sessionTokenRefusal: 'revoked' as const }],
    ['matched but no longer bound', { callerAttribution: socketAttribution('match'), tokenBinding: () => undefined }],
  ])('refuses protected delivery when the session token is %s', async (_case, overrides) => {
    const refused: SessionContext = { ...directSession, ...overrides };
    const staged = await registry.call('request_rustdesk_access', { device_id: 'device-1', purpose: 'login' }, refused);
    expect(staged.isError).toBe(true);
    expect(staged.content[0].text).toContain('accepted session token');
    expect(sends).toEqual([]);

    // The refusal comes from the shared identity check, before the service is reached for either call.
    await registry.call('request_rustdesk_access', { device_id: 'device-1', purpose: 'login' }, directSession);
    const delivered = await registry.call('deliver_secret', { delivery_ref: DELIVERY_REF }, refused);
    const status = await registry.call('get_secret_delivery_status', { delivery_id: DELIVERY_ID }, refused);
    expect(delivered.isError).toBe(true);
    expect(delivered.content[0].text).toContain('accepted session token');
    expect(status.isError).toBe(true);
    expect(status.content[0].text).toContain('accepted session token');
  });

  // send_message keeps tokenless socket callers working; so does protected delivery. Every socket request
  // carries a binding callback, which answers undefined when no token was presented.
  it('accepts a bound direct socket caller that presented no session token', async () => {
    const tokenless: SessionContext = {
      ...directSession, callerAttribution: socketAttribution('absent'), tokenBinding: () => undefined,
    };
    const staged = await registry.call('request_rustdesk_access', { device_id: 'device-1', purpose: 'login' }, tokenless);
    expect(staged.isError).toBeFalsy();
    expectOpaqueSubmittedResponse(staged.content[0].text);
    expect(sends).toHaveLength(1);
  });

  it('stores a mapped LID request under its verified phone destination', async () => {
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111112345', '15551234567@s.whatsapp.net');

    const result = await registry.call('request_rustdesk_access', {
      device_id: 'device-1', purpose: 'login',
    }, {
      tier: 'chat-scoped',
      actorJid: '11111112345@lid',
      deliveryJid: '11111112345@lid',
      conversationKey: '15551234567',
    });

    expect(result.isError).toBeUndefined();
    expect(db.raw.prepare('SELECT principal, recipient_jid FROM protected_deliveries').get())
      .toEqual({ principal: '15551234567', recipient_jid: '15551234567@s.whatsapp.net' });
  });
});
