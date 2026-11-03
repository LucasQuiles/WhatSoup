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
import { OutboundGovernor, wrapWithOutboundGovernor } from '../../src/transport/outbound-governor.ts';

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
    admit: vi.fn(async () => ({ attemptId: 'attempt-1', payloadDigest: 'sha256:payload' })),
    recordReceipt: vi.fn(async () => undefined),
  };
}

function fakeSocket() {
  return {
    sendMessage: vi.fn(async (_jid: string, content: unknown) => ({ key: { id: 'provider-1' }, content })),
    relayMessage: vi.fn(async () => 'provider-relay-1'),
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

  it('surfaces both a provider failure and a failed unknown receipt without retrying', async () => {
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

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([providerFailure, receiptFailure]);
    expect(realSend).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledTimes(1);
    expect(authority.recordReceipt).toHaveBeenCalledWith({ attemptId: 'attempt-1', state: 'unknown' });
  });

  it('gates media and control sends even though pacing does not apply to them', async () => {
    // Break caught: a media/control path bypasses the universal authority boundary.
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
      await socket.sendMessage('15551230000@s.whatsapp.net', { react: { text: '👍' } });
    });

    expect(authority.admit).toHaveBeenCalledTimes(2);
    expect(authority.recordReceipt).toHaveBeenCalledTimes(2);
  });

  it('binds the status audience and options to the authority snapshot before the provider call', async () => {
    // Break caught: post_status sends recipient data in Baileys' third argument,
    // which must not remain an unreviewed mutable passthrough after admission.
    const authority = acceptingAuthority();
    const gate = new FinalTransportAuthorityGate(authority);
    const socket = fakeSocket();
    const options = { statusJidList: ['15551230000@s.whatsapp.net'], font: 2 };
    authority.admit.mockImplementationOnce(async (input) => {
      options.statusJidList.push('15551239999@s.whatsapp.net');
      return { attemptId: 'attempt-status', payloadDigest: 'sha256:status' };
    });
    wrapWithOutboundGovernor(socket, {
      governor: permissiveGovernor(),
      resolveDest: (jid) => jid,
      authorityGate: gate,
    });

    await withTransportInboundContext({ inbound_event_id: 'inbound-status' }, async () => {
      await socket.sendMessage('status@broadcast', { text: 'approved status' }, options);
    });

    expect(authority.admit).toHaveBeenCalledWith({
      recipient: 'status@broadcast',
      content: { text: 'approved status' },
      options: { statusJidList: ['15551230000@s.whatsapp.net'], font: 2 },
      context: { inbound_event_id: 'inbound-status' },
    });
    expect(socket.sendMessage).toHaveBeenCalledWith('status@broadcast', { text: 'approved status' }, {
      statusJidList: ['15551230000@s.whatsapp.net'],
      font: 2,
    });
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
