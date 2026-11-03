import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  FinalTransportAuthorityGate,
  TransportAuthorityUnavailableError,
  freezeOutboundContent,
  freezeOutboundOptions,
  getTransportInboundContext,
  registerTrustedInbound,
  renderTransportReviewCard,
  retryApprovedWhatsappOperations,
  sendFixedControlReceipt,
  withTransportInboundContext,
} from '../../src/transport/operations-authority-gate.ts';
import {
  OutboundGovernor,
  TransportAuthorityProviderOutcomeUnknownError,
  wrapWithOutboundGovernor,
} from '../../src/transport/outbound-governor.ts';
import type {
  TransportAdmission,
  TransportAdmissionInput,
  TransportReceiptInput,
} from '../../src/transport/operations-authority-client.ts';

function permissiveGovernor() {
  return new OutboundGovernor({
    windowMs: 1_000,
    maxPerWindow: 100,
    maxWaitMs: 10,
    hardCeiling: 100,
    hardCeilingWindowMs: 1_000,
    globalMaxPerWindow: 100,
    globalWindowMs: 1_000,
  });
}

function acceptingAuthority() {
  return {
    admit: vi.fn<(input: TransportAdmissionInput) => Promise<TransportAdmission>>(
      async () => ({ attemptId: 'attempt-1', payloadDigest: 'sha256:payload' }),
    ),
    recordReceipt: vi.fn<(input: TransportReceiptInput) => Promise<void>>(async () => undefined),
  };
}

function fakeSocket() {
  return {
    sendMessage: vi.fn<(
      jid: string,
      content: unknown,
      options?: unknown,
    ) => Promise<{ key: { id: string }; content: unknown }>>(
      async (_jid, content, _options) => ({ key: { id: 'provider-1' }, content }),
    ),
    relayMessage: vi.fn<(jid: string, content: unknown, options: unknown) => Promise<string>>(
      async (_jid, _content, _options) => 'provider-relay-1',
    ),
  };
}

const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 10_000;
const SNAPSHOT_MAX_KEYS_PER_OBJECT = 1_024;
const SNAPSHOT_MAX_KEY_BYTES = 4_096;
const SNAPSHOT_MAX_BINARY_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_MAX_ENCODED_BYTES = 75 * 1024 * 1024;

function nestedSnapshot(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { text: 'approved' };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function nestedBinaryContent(depth: number): unknown {
  let value: unknown = Buffer.from('approved');
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function wideSnapshot(keys: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: keys }, (_value, index) => [`field${index}`, index]));
}

function approvedWhatsappOperation(content: unknown, options?: Record<string, unknown>) {
  return {
    id: 'operation-bounded',
    accountId: 'pilot-account',
    action: 'whatsapp.send',
    payload: {
      recipient: '15551230000@s.whatsapp.net',
      content,
      ...(options === undefined ? {} : { options }),
    },
    digest: 'sha256:bounded',
    state: 'approved',
  };
}

describe('freezeOutboundContent', () => {
  it('copies attachment bytes for both the approval snapshot and the wire payload', () => {
    // Break caught: mutating a caller-owned Buffer after admission changes the delivered attachment.
    const source = Buffer.from('original');
    const frozen = freezeOutboundContent({ document: source, fileName: 'report.txt' });
    source.fill(0);

    expect(frozen.approvalContent).toEqual({
      document: { $binary: 'b3JpZ2luYWw=' },
      fileName: 'report.txt',
    });
    expect((frozen.wireContent as { document: Buffer }).document.toString()).toBe('original');
  });

  it('refuses a stream or URL-backed attachment that cannot be frozen honestly', () => {
    // Break caught: authority approves a reference while the provider later dereferences changed bytes.
    expect(() => freezeOutboundContent({ image: Readable.from(['not-frozen']) })).toThrow(/stream/i);
    expect(() => freezeOutboundContent({ image: { url: 'https://example.test/image.png' } })).toThrow(/URL-backed/i);
  });

  it('copies all provider-visible options, including the actual status audience', () => {
    // Break caught: a mutable statusJidList changes the delivered audience after
    // approval, while the authority digest binds only status@broadcast.
    const audience = ['15551230000@s.whatsapp.net'];
    const frozen = freezeOutboundOptions({ statusJidList: audience, quoted: { id: 'quoted-1' } });
    audience.push('15551239999@s.whatsapp.net');

    expect(frozen.approvalOptions).toEqual({
      statusJidList: ['15551230000@s.whatsapp.net'],
      quoted: { id: 'quoted-1' },
    });
    expect(frozen.wireOptions).toEqual(frozen.approvalOptions);
    expect(frozen.wireOptions).not.toBe(frozen.approvalOptions);
  });

  it('rejects prototype keys before they can hide provider content from approval', async () => {
    const options = JSON.parse('{"__proto__":{"statusJidList":["third-party@s.whatsapp.net"]}}');
    const authority = acceptingAuthority();
    const socket = fakeSocket();
    const send = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });
    const content = JSON.parse('{"__proto__":{"text":"unreviewed body"}}');
    await expect(socket.sendMessage('owner@s.whatsapp.net', content)).rejects.toThrow(/prototype/i);
    expect(authority.admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(() => freezeOutboundContent({ contextInfo: options })).toThrow(/prototype/i);
    expect(() => freezeOutboundOptions(options)).toThrow();
  });

  it('accepts snapshot structures at the depth, node, object-key, and key-byte limits', () => {
    expect(() => freezeOutboundContent(nestedSnapshot(SNAPSHOT_MAX_DEPTH))).not.toThrow();
    expect(() => freezeOutboundContent(Array.from({ length: SNAPSHOT_MAX_NODES - 1 }, () => null))).not.toThrow();
    expect(() => freezeOutboundContent(wideSnapshot(SNAPSHOT_MAX_KEYS_PER_OBJECT))).not.toThrow();
    expect(() => freezeOutboundContent({ ['k'.repeat(SNAPSHOT_MAX_KEY_BYTES)]: 'approved' })).not.toThrow();
  });

  it('rejects snapshot structures beyond the depth, node, object-key, and key-byte limits', () => {
    expect(() => freezeOutboundContent(nestedSnapshot(SNAPSHOT_MAX_DEPTH + 1))).toThrow(/depth/i);
    expect(() => freezeOutboundContent(Array.from({ length: SNAPSHOT_MAX_NODES }, () => null))).toThrow(/nodes/i);
    expect(() => freezeOutboundContent(wideSnapshot(SNAPSHOT_MAX_KEYS_PER_OBJECT + 1))).toThrow(/keys/i);
    expect(() => freezeOutboundContent({ ['k'.repeat(SNAPSHOT_MAX_KEY_BYTES + 1)]: 'approved' })).toThrow(/key/i);
  });

  it('keeps the binary depth boundary symmetric with approved replay and blocks one deeper before send', async () => {
    const accepted = freezeOutboundContent(nestedBinaryContent(SNAPSHOT_MAX_DEPTH));
    const replay = vi.fn(async () => undefined);
    await retryApprovedWhatsappOperations({
      accountId: 'pilot-account',
      inboundEventId: 'inbound-approve',
      operations: [approvedWhatsappOperation(accepted.approvalContent)],
      send: replay,
    });
    expect(replay).toHaveBeenCalledOnce();

    const authority = acceptingAuthority();
    const socket = fakeSocket();
    const providerSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    await expect(socket.sendMessage('owner@s.whatsapp.net', nestedBinaryContent(SNAPSHOT_MAX_DEPTH + 1)))
      .rejects.toThrow(/depth/i);
    expect(authority.admit).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('accounts for JSON escaping and lone surrogates before accepting metadata at the encoded-byte boundary', () => {
    // {"text":"..."} contributes 11 bytes outside six-byte JSON escapes.
    const maximumControlCharacters = Math.floor((SNAPSHOT_MAX_ENCODED_BYTES - 11) / 6);
    expect(() => freezeOutboundContent({ text: '\0'.repeat(maximumControlCharacters - 1) })).not.toThrow();
    const atBoundaryText = '\0'.repeat(maximumControlCharacters - 1) + '\ud800'
      + 'x'.repeat(SNAPSHOT_MAX_ENCODED_BYTES - 11 - (maximumControlCharacters * 6));
    const atBoundary = freezeOutboundContent({ text: atBoundaryText });
    expect(Buffer.byteLength(JSON.stringify(atBoundary.approvalContent))).toBe(SNAPSHOT_MAX_ENCODED_BYTES);
    expect(() => freezeOutboundContent({ text: `${atBoundaryText}x` }))
      .toThrow(/encoded bytes/i);
  });

  it('accepts binary payloads below and at the provider media limit', () => {
    for (const size of [SNAPSHOT_MAX_BINARY_BYTES - 1, SNAPSHOT_MAX_BINARY_BYTES]) {
      const frozen = freezeOutboundContent({ document: Buffer.alloc(size) });
      expect((frozen.wireContent as { document: Buffer }).document).toHaveLength(size);
    }
  });

  it('rejects oversized binary and cyclic outbound content before authority admission or provider submission', async () => {
    const authority = acceptingAuthority();
    const socket = fakeSocket();
    const providerSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    await expect(socket.sendMessage('owner@s.whatsapp.net', {
      document: Buffer.alloc(SNAPSHOT_MAX_BINARY_BYTES + 1),
    })).rejects.toThrow(/binary/i);
    const cyclic: Record<string, unknown> = { text: 'blocked' };
    cyclic['self'] = cyclic;
    await expect(socket.sendMessage('owner@s.whatsapp.net', cyclic)).rejects.toThrow(/cycle/i);

    expect(authority.admit).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('rejects binary spread across content and options before authority admission or provider submission', async () => {
    const authority = acceptingAuthority();
    const socket = fakeSocket();
    const providerSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    await expect(socket.sendMessage(
      'owner@s.whatsapp.net',
      { document: Buffer.alloc(SNAPSHOT_MAX_BINARY_BYTES / 2) },
      { quoted: Buffer.alloc((SNAPSHOT_MAX_BINARY_BYTES / 2) + 1) },
    )).rejects.toThrow(/binary/i);

    expect(authority.admit).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });
});

describe('FinalTransportAuthorityGate at the final socket seam', () => {
  it('binds an admitted reply to the active registered inbound event and records provider acceptance', async () => {
    // Break caught: losing the trusted turn binding allows a normal reply to be staged as arbitrary outbound.
    const authority = acceptingAuthority();
    const gate = new FinalTransportAuthorityGate(authority);
    const socket = fakeSocket();
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: gate,
    });

    await withTransportInboundContext({ inbound_event_id: 'inbound-1' }, async () => {
      await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' });
    });

    expect(authority.admit).toHaveBeenCalledWith({
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'reply' },
      context: { inbound_event_id: 'inbound-1' },
    });
    expect(authority.recordReceipt).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      state: 'provider_accepted',
      providerId: 'provider-1',
    });
    expect(socket.sendMessage.mock.calls).toHaveLength(1);
  });

  it('marks a provider failure with a failed unknown receipt as an authority-admitted ambiguous outcome', async () => {
    // Break caught: failure to persist an ambiguous outcome is swallowed, making
    // an authority dispatch appear observable when neither outcome is reliable.
    const providerFailure = new Error('provider disconnected');
    const receiptFailure = new Error('authority unavailable');
    const authority = acceptingAuthority();
    authority.recordReceipt.mockRejectedValueOnce(receiptFailure);
    const socket = fakeSocket();
    socket.sendMessage.mockRejectedValue(providerFailure);
    const realSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    let thrown: unknown;
    try {
      await withTransportInboundContext({ inbound_event_id: 'inbound-failed-receipt' }, async () => {
        await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({
      name: 'TransportAuthorityProviderOutcomeUnknownError',
      code: 'TRANSPORT_AUTHORITY_PROVIDER_OUTCOME_UNKNOWN',
      cause: expect.objectContaining({
        errors: [providerFailure, receiptFailure],
      }),
    });
    expect(realSend).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledWith({ attemptId: 'attempt-1', state: 'unknown' });
  });

  it('marks a failed accepted receipt as an authority-admitted ambiguous outcome', async () => {
    // Break caught: a provider success followed by an authority receipt failure
    // escaped as the original error and let internal callers retry it.
    const acceptedReceiptFailure = new Error('accepted receipt unavailable');
    const authority = acceptingAuthority();
    authority.recordReceipt.mockRejectedValueOnce(acceptedReceiptFailure);
    const socket = fakeSocket();
    const realSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    let thrown: unknown;
    try {
      await withTransportInboundContext({ inbound_event_id: 'inbound-accepted-receipt-failure' }, async () => {
        await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TransportAuthorityProviderOutcomeUnknownError);
    expect(thrown).toMatchObject({ cause: acceptedReceiptFailure });
    expect(realSend).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenNthCalledWith(1, {
      attemptId: 'attempt-1',
      state: 'provider_accepted',
      providerId: 'provider-1',
    });
    expect(authority.recordReceipt).toHaveBeenNthCalledWith(2, { attemptId: 'attempt-1', state: 'unknown' });
  });

  it('preserves both receipt failures after a provider success as an ambiguous outcome', async () => {
    // Break caught: a failed fallback receipt hides that the accepted receipt
    // already failed, preventing the caller from seeing the reconciliation gap.
    const acceptedReceiptFailure = new Error('accepted receipt unavailable');
    const unknownReceiptFailure = new Error('unknown receipt unavailable');
    const authority = acceptingAuthority();
    authority.recordReceipt
      .mockRejectedValueOnce(acceptedReceiptFailure)
      .mockRejectedValueOnce(unknownReceiptFailure);
    const socket = fakeSocket();
    const realSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    let thrown: unknown;
    try {
      await withTransportInboundContext({ inbound_event_id: 'inbound-double-receipt-failure' }, async () => {
        await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TransportAuthorityProviderOutcomeUnknownError);
    expect(thrown).toMatchObject({
      cause: expect.objectContaining({ errors: [acceptedReceiptFailure, unknownReceiptFailure] }),
    });
    expect(realSend).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledTimes(2);
  });

  it('marks a synchronous provider throw as an authority-admitted ambiguous outcome', async () => {
    // Break caught: Promise.resolve(realSend(...)) evaluates its argument first,
    // so a synchronous provider throw could escape the no-retry outcome type.
    const providerFailure = new Error('provider threw synchronously');
    const authority = acceptingAuthority();
    const socket = fakeSocket();
    socket.sendMessage.mockImplementation(() => {
      throw providerFailure;
    });
    const realSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    let thrown: unknown;
    try {
      await withTransportInboundContext({ inbound_event_id: 'inbound-sync-failure' }, async () => {
        await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TransportAuthorityProviderOutcomeUnknownError);
    expect(thrown).toMatchObject({
      name: 'TransportAuthorityProviderOutcomeUnknownError',
      code: 'TRANSPORT_AUTHORITY_PROVIDER_OUTCOME_UNKNOWN',
      cause: providerFailure,
    });
    expect(realSend).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledWith({ attemptId: 'attempt-1', state: 'unknown' });
  });

  it('admits known frozen media semantics at the final authority boundary', async () => {
    // Break caught: the semantic hold accidentally disables ordinary media replies.
    const authority = acceptingAuthority();
    const gate = new FinalTransportAuthorityGate(authority);
    const socket = fakeSocket();
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: gate,
    });

    await withTransportInboundContext({ inbound_event_id: 'inbound-1' }, async () => {
      await socket.sendMessage('15551230000@s.whatsapp.net', { image: Buffer.from('image') });
    });

    expect(authority.admit).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledTimes(1);
  });

  it('admits a known reply with its stable provider message ID option', async () => {
    // Break caught: a semantic hold rejects the ordinary message-id option used
    // to make a provider retry idempotent.
    const authority = acceptingAuthority();
    const gate = new FinalTransportAuthorityGate(authority);
    const socket = fakeSocket();
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: gate,
    });

    await withTransportInboundContext({ inbound_event_id: 'inbound-1' }, async () => {
      await socket.sendMessage('15551230000@s.whatsapp.net', { text: 'reply' }, { messageId: 'provider-1' });
    });

    expect(authority.admit).toHaveBeenCalledWith(expect.objectContaining({
      options: { messageId: 'provider-1' },
    }));
    expect(socket.sendMessage).toHaveBeenCalledWith(
      '15551230000@s.whatsapp.net',
      { text: 'reply' },
      { messageId: 'provider-1' },
    );
  });

  it('holds unsupported raw payloads and audience options before admission even with an explicit operation', async () => {
    // Break caught: raw MCP payloads borrow ordinary reply or released-operation
    // authority despite having no deterministic semantic review adapter.
    const authority = acceptingAuthority();
    const gate = new FinalTransportAuthorityGate(authority);
    const socket = fakeSocket();
    const providerSend = socket.sendMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: gate,
    });

    await withTransportInboundContext({
      inbound_event_id: 'inbound-operation',
      operation_id: 'released-operation',
    }, async () => {
      for (const content of [
        { sharePhoneNumber: true },
        { requestPhoneNumber: true },
        { product: { productId: 'catalog-1' } },
        { groupInvite: { groupJid: 'group@g.us', inviteCode: 'code' } },
        { react: { text: '👍' } },
      ]) {
        await expect(socket.sendMessage('15551230000@s.whatsapp.net', content))
          .rejects.toThrow(/semantic adapter/i);
      }
      await expect(socket.sendMessage(
        'status@broadcast',
        { text: 'status must be held' },
        { statusJidList: ['15551239999@s.whatsapp.net'] },
      )).rejects.toThrow(/semantic adapter/i);
    });

    expect(authority.admit).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('blocks raw protobuf relay while the authority cannot review its semantics', async () => {
    // Break caught: relay_message reaches Baileys directly without an approved
    // recipient, bytes, options, dispatch record, or provider receipt.
    const authority = acceptingAuthority();
    const socket = fakeSocket();
    const rawRelay = socket.relayMessage;
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });

    await expect(socket.relayMessage('15551230000@s.whatsapp.net', { conversation: 'raw' }, {}))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(authority.admit).not.toHaveBeenCalled();
    expect(rawRelay).not.toHaveBeenCalled();
  });

  it('does not reach the provider when the configured authority is unavailable', async () => {
    // Break caught: a missing protected client silently disables the enabled send control.
    const socket = fakeSocket();
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: {
        admit: async () => { throw new TransportAuthorityUnavailableError('not qualified'); },
        recordReceipt: async () => undefined,
      },
    });

    await expect(socket.sendMessage('15551230000@s.whatsapp.net', { text: 'blocked' }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(socket.sendMessage.mock.calls).toHaveLength(0);
  });
});

describe('registerTrustedInbound', () => {
  it('keeps a server-paused /stop command out of the conversational runtime', async () => {
    // Break caught: an inbound stop reaches conversational queueing before the
    // authority can linearize pause against later send admission.
    const calls: string[] = [];
    const authority = {
      registerInbound: vi.fn(async () => {
        calls.push('inbound');
        return {
          kind: 'paused' as const,
          receipt: {
            id: 'receipt-stop',
            accountId: 'pilot-account',
            action: 'whatsapp.control_receipt',
            payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'Notifications paused.' } },
            digest: 'sha256:receipt',
            state: 'approved',
          },
        };
      }),
      closeInbound: vi.fn(async () => { calls.push('close'); }),
    };

    await registerTrustedInbound(authority, {
      eventId: 'inbound-stop',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      content: ' /STOP ',
    }, async (result) => {
      if (result.kind === 'inbound') calls.push('runtime');
    });

    expect(calls).toEqual(['inbound', 'close']);
  });

  it('does not invoke the runtime if protected inbound registration fails', async () => {
    // Break caught: unregistered inbound data manufactures a trusted reply context.
    const authority = {
      registerInbound: vi.fn(async () => { throw new TransportAuthorityUnavailableError('offline'); }),
      closeInbound: vi.fn(async () => undefined),
    };
    const runtime = vi.fn();

    await expect(registerTrustedInbound(authority, {
      eventId: 'inbound-1',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      content: 'hello',
    }, runtime)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(runtime).not.toHaveBeenCalled();
  });

  it('closes only after an asynchronous trusted turn settles', async () => {
    // Break caught: accepted queue admission closes the lease before its
    // later reply can use the authenticated inbound context.
    let resolveTurn!: () => void;
    const turn = new Promise<void>((resolve) => { resolveTurn = resolve; });
    const authority = {
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    };
    const delivery = registerTrustedInbound(authority, {
      eventId: 'inbound-async',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      content: 'hello',
    }, async () => turn);

    await vi.waitFor(() => expect(authority.registerInbound).toHaveBeenCalledTimes(1));
    expect(authority.closeInbound).not.toHaveBeenCalled();
    resolveTurn();
    await delivery;
    expect(authority.closeInbound).toHaveBeenCalledWith({ eventId: 'inbound-async' });
  });

  it('closes a trusted inbound lease when its turn fails', async () => {
    const authority = {
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    };

    await expect(registerTrustedInbound(authority, {
      eventId: 'inbound-error',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      content: 'hello',
    }, async () => { throw new Error('turn failed'); })).rejects.toThrow('turn failed');
    expect(authority.closeInbound).toHaveBeenCalledWith({ eventId: 'inbound-error' });
  });
});

describe('protected review delivery and retry', () => {
  it('renders the authority review as exact JSON-escaped plain text with executable owner commands', () => {
    // Break caught: asking the conversational model to paraphrase or choose a held operation.
    expect(renderTransportReviewCard({
      challenge: 'challenge-7',
      items: [{ id: 'operation-1', digest: 'sha256:payload' }],
      previews: [{
        id: 'operation-1',
        accountId: 'pilot-account',
        action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'held reply' } },
        digest: 'sha256:payload',
        state: 'held',
      }],
      expiresAt: '2026-11-02T15:00:00.000Z',
    })).toContain('/approve challenge-7 operation-1');
    expect(renderTransportReviewCard({
      challenge: 'challenge-7',
      items: [{ id: 'operation-1', digest: 'sha256:payload' }],
      previews: [{
        id: 'operation-1',
        accountId: 'pilot-account',
        action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'held reply' } },
        digest: 'sha256:payload',
        state: 'held',
      }],
      expiresAt: '2026-11-02T15:00:00.000Z',
    })).toContain('"recipient":"15551230000@s.whatsapp.net"');
  });

  it('renders every semantic mail field and omits opaque Graph or MIME payload bytes', () => {
    // Break caught: a reviewer sees an opaque provider envelope instead of the
    // sender, recipients, body, headers, and attachment digest they approve.
    const card = renderTransportReviewCard({
      challenge: 'challenge-mail',
      items: [{ id: 'mail-operation-1', digest: 'sha256:mail-preview' }],
      previews: [{
        id: 'mail-operation-1', accountId: 'pilot-account', action: 'mail.send',
        payload: { graph_message_json: 'opaque-graph-attacker@example.test', mime_base64: 'opaque-mime' },
        digest: 'sha256:mail-preview', state: 'pending',
        preview: {
          sender: 'sender@example.test', from: 'from@example.test', replyTo: ['reply@example.test'],
          subject: 'Reviewed subject', body: 'Reviewed body', contentType: 'HTML',
          to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'], mailbox: 'me',
          attachments: [{
            index: 0, name: 'reviewed.pdf', size: 42, sha256: 'a'.repeat(64),
            contentType: 'application/pdf', isInline: false, contentId: null,
          }],
          extraHeaders: { 'x-reviewed': 'yes' },
          deskUrl: 'https://authority.example/operation-review',
        },
      }],
      expiresAt: '2026-11-02T15:00:00.000Z',
    });

    for (const value of [
      'sender@example.test', 'from@example.test', 'reply@example.test', 'Reviewed subject',
      'Reviewed body', 'to@example.test', 'cc@example.test', 'bcc@example.test', 'reviewed.pdf',
      'application/pdf', '"x-reviewed":"yes"', 'https://authority.example/operation-review',
    ]) expect(card).toContain(value);
    expect(card).not.toContain('opaque-graph-attacker@example.test');
    expect(card).not.toContain('opaque-mime');
    expect(card).not.toContain('graph_message_json');
    expect(card).toContain('/approve challenge-mail mail-operation-1');
  });

  it('fails visibly without executable commands when a complete review card exceeds the WhatsApp limit', () => {
    // Break caught: long recipients/body/header metadata is silently truncated
    // while an approval command still authorizes information the human cannot see.
    const card = renderTransportReviewCard({
      challenge: 'challenge-mail',
      items: [{ id: 'mail-operation-1', digest: 'sha256:mail-preview' }],
      previews: [{
        id: 'mail-operation-1', accountId: 'pilot-account', action: 'mail.send', payload: {},
        digest: 'sha256:mail-preview', state: 'pending',
        preview: {
          sender: 'sender@example.test', from: 'from@example.test', replyTo: [], subject: 'subject',
          body: 'x'.repeat(4_100), contentType: 'Text', to: ['to@example.test'], cc: [], bcc: [], mailbox: 'me',
          attachments: [], extraHeaders: {}, deskUrl: 'https://authority.example/operation-review',
        },
      }],
      expiresAt: '2026-11-02T15:00:00.000Z',
    });

    expect(card).toContain('exceeds the WhatsApp review-card limit');
    expect(card).toContain('https://authority.example/operation-review');
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/reject');
    expect(card).not.toContain('x'.repeat(100));
  });

  it('retries only authority-approved WhatsApp operations under the matching trusted operation context', async () => {
    // Break caught: a decision response could replay an already-dispatched row,
    // a different account, a rejected row, or a model-provided payload.
    const seen: Array<{ recipient: string; content: unknown; options?: Record<string, unknown>; context: unknown }> = [];
    await retryApprovedWhatsappOperations({
      accountId: 'pilot-account',
      inboundEventId: 'inbound-approve',
      operations: [
        {
          id: 'operation-1',
          accountId: 'pilot-account',
          action: 'whatsapp.send',
          payload: {
            recipient: '15551230000@s.whatsapp.net',
            content: { document: { $binary: 'aGVsbG8=' } },
            options: { timestamp: 1_700_000_000 },
          },
          digest: 'sha256:payload',
          state: 'approved',
        },
        {
          id: 'operation-dispatching',
          accountId: 'pilot-account',
          action: 'whatsapp.send',
          payload: { recipient: '15551230001@s.whatsapp.net', content: { text: 'must not send' } },
          digest: 'sha256:dispatching',
          state: 'dispatching',
        },
        {
          id: 'operation-rejected',
          accountId: 'pilot-account',
          action: 'whatsapp.send',
          payload: { recipient: '15551230002@s.whatsapp.net', content: { text: 'must not send' } },
          digest: 'sha256:rejected',
          state: 'rejected',
        },
      ],
      send: async (recipient, content, options) => {
        seen.push({ recipient, content, options, context: getTransportInboundContext() });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      recipient: '15551230000@s.whatsapp.net',
      context: { inbound_event_id: 'inbound-approve', operation_id: 'operation-1' },
    });
    expect((seen[0]?.content as { document: Buffer }).document.toString()).toBe('hello');
    expect(seen[0]?.options).toEqual({ timestamp: 1_700_000_000 });
  });

  it('rejects malformed, non-finite, cyclic, deep, wide, and oversized authority snapshots before any provider submission', async () => {
    const malformedBinary = { $binary: 'not-base64' };
    const cyclic: Record<string, unknown> = { text: 'blocked' };
    cyclic['self'] = cyclic;
    const oversizedBinary = { $binary: 'A'.repeat((Math.ceil(SNAPSHOT_MAX_BINARY_BYTES / 3) * 4) + 4) };
    const invalidContents: unknown[] = [
      malformedBinary,
      Number.POSITIVE_INFINITY,
      cyclic,
      nestedSnapshot(SNAPSHOT_MAX_DEPTH + 1),
      wideSnapshot(SNAPSHOT_MAX_KEYS_PER_OBJECT + 1),
      oversizedBinary,
    ];

    for (const content of invalidContents) {
      const send = vi.fn(async () => undefined);
      await expect(retryApprovedWhatsappOperations({
        accountId: 'pilot-account',
        inboundEventId: 'inbound-approve',
        operations: [approvedWhatsappOperation(content)],
        send,
      })).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('rejects an aggregate approved snapshot across content and options before any provider submission', async () => {
    const send = vi.fn(async () => undefined);
    const half = SNAPSHOT_MAX_BINARY_BYTES / 2;
    await expect(retryApprovedWhatsappOperations({
      accountId: 'pilot-account',
      inboundEventId: 'inbound-approve',
      operations: [approvedWhatsappOperation(
        { document: { $binary: Buffer.alloc(half).toString('base64') } },
        { quoted: { $binary: Buffer.alloc(half + 1).toString('base64') } },
      )],
      send,
    })).rejects.toThrow(/binary/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends only the authority-created approved control receipt for a paused event', async () => {
    // Break caught: a generic approved WhatsApp operation is used as a paused-account acknowledgement.
    const seen: Array<{ recipient: string; content: unknown; context: unknown }> = [];
    await sendFixedControlReceipt({
      accountId: 'pilot-account',
      inboundEventId: 'inbound-stop',
      receipt: {
        id: 'receipt-stop',
        accountId: 'pilot-account',
        action: 'whatsapp.control_receipt',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'Notifications paused.' } },
        digest: 'sha256:receipt',
        state: 'approved',
      },
      send: async (recipient, content) => {
        seen.push({ recipient, content, context: getTransportInboundContext() });
      },
    });

    expect(seen).toEqual([{
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'Notifications paused.' },
      context: { inbound_event_id: 'inbound-stop', operation_id: 'receipt-stop' },
    }]);
  });

  it('refuses a generic or replay-state operation as a paused control receipt', async () => {
    // Break caught: a caller labels arbitrary work as a system acknowledgement
    // after pause instead of relying on the authority's one-use grant.
    const send = vi.fn(async () => undefined);
    await expect(sendFixedControlReceipt({
      accountId: 'pilot-account',
      inboundEventId: 'inbound-stop',
      receipt: {
        id: 'not-a-receipt',
        accountId: 'pilot-account',
        action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'must not send' } },
        digest: 'sha256:wrong',
        state: 'approved',
      },
      send,
    })).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(send).not.toHaveBeenCalled();
  });
});
