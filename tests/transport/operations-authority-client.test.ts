import { chmodSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  OperationsAuthorityClient,
  TransportApprovalRequiredError,
  TransportAuthorityUnavailableError,
  createProtectedOperationsAuthorityClient,
} from '../../src/transport/operations-authority-client.ts';

type Call = { url: string; init: RequestInit };
const tmpDirs = trackTmpDirs('operations-authority-client');

function response(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(responses: Response[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  return {
    client: new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    }),
    calls,
  };
}

describe('OperationsAuthorityClient authority URL policy', () => {
  it.each([
    'http://authority.example',
    'http://localhost:8080',
    'http://127.0.0.2:8080',
    'http://127.1:8080',
    'https://operator:secret@authority.example',
    'https://authority.example/?unexpected=query',
    'https://authority.example/#unexpected-fragment',
  ])('rejects unsafe authority base URL %s before it can invoke fetch', (baseUrl) => {
    // Break caught: a privileged bearer travels over remote plaintext HTTP or
    // a credential/query/fragment-bearing URL reaches the protected service.
    const fetch = vi.fn();

    expect(() => new OperationsAuthorityClient({
      baseUrl,
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    })).toThrow(TransportAuthorityUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://authority.example',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
  ])('allows trusted authority base URL %s with a fake transport only', async (baseUrl) => {
    const fetch = vi.fn(async () => response(200, {
      attempt_id: 'attempt-url-policy',
      payload_digest: 'sha256:url-policy',
      state: 'dispatching',
    }));
    const client = new OperationsAuthorityClient({
      baseUrl,
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'fake-only' },
    })).resolves.toEqual({ attemptId: 'attempt-url-policy', payloadDigest: 'sha256:url-policy' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('OperationsAuthorityClient admission contract', () => {
  it('admits a final payload with only the authenticated inbound event context', async () => {
    // Break caught: a wrong endpoint, action, adapter version, or caller-supplied
    // destination context would allow authority drift at the transport boundary.
    const { client, calls } = clientWith([
      response(200, { attempt_id: 'attempt-1', payload_digest: 'sha256:abc', state: 'dispatching' }),
    ]);

    await expect(client.admit({
      recipient: '15551230000@s.whatsapp.net',
      content: { text: 'final redacted text' },
      // Runtime extras cannot turn into unsupported context keys on the wire;
      // released operation identity is the separate envelope field below.
      context: { inbound_event_id: 'inbound-1', operation_id: 'must-not-serialize' } as any,
      operationId: 'operation-approved-1',
    })).resolves.toEqual({ attemptId: 'attempt-1', payloadDigest: 'sha256:abc' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://authority.example/operations/transport/admit',
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-only-transport-token',
          'content-type': 'application/json',
        },
      },
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      account_id: 'pilot-account',
      action: 'whatsapp.send',
      adapter_version: 1,
      payload: {
        recipient: '15551230000@s.whatsapp.net',
        content: { text: 'final redacted text' },
      },
      context: { inbound_event_id: 'inbound-1' },
      operation_id: 'operation-approved-1',
    });
  });

  it('carries frozen provider-visible options in the authority payload', async () => {
    // Break caught: status recipients in statusJidList reach Baileys without
    // appearing in the exact payload the authority hashes and reviews.
    const { client, calls } = clientWith([
      response(200, { attempt_id: 'attempt-options', payload_digest: 'sha256:options', state: 'dispatching' }),
    ]);

    await client.admit({
      recipient: 'status@broadcast',
      content: { text: 'status' },
      options: { statusJidList: ['15551230000@s.whatsapp.net'], font: 1 },
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      payload: {
        recipient: 'status@broadcast',
        content: { text: 'status' },
        options: { statusJidList: ['15551230000@s.whatsapp.net'], font: 1 },
      },
    });
  });

  it('turns a review hold into a typed approval-required failure before wire dispatch', async () => {
    // Break caught: treating a staged generic outgoing message as admitted.
    const { client } = clientWith([
      response(409, { detail: 'approval_required', operation_id: 'operation-7' }),
    ]);

    await expect(client.admit({ recipient: 'other@s.whatsapp.net', content: { text: 'new outbound' } }))
      .rejects.toEqual(expect.objectContaining({
        name: TransportApprovalRequiredError.name,
        operationId: 'operation-7',
      }));
  });

  it('fails closed when the authority response is malformed', async () => {
    // Break caught: accepting a response without a durable one-use dispatch id.
    const { client } = clientWith([
      response(200, { attempt_id: 'attempt-1', state: 'dispatching' }),
    ]);

    await expect(client.admit({ recipient: 'target@s.whatsapp.net', content: { text: 'hello' } }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });
});

describe('OperationsAuthorityClient ingress and receipt contract', () => {
  it('submits authenticated inbound text and returns a server-bound review instruction', async () => {
    // Break caught: letting a model parse a review command or compose the
    // selection would turn a human approval path into agent-controlled input.
    const review = {
      kind: 'review',
      review: {
        challenge: 'challenge-7',
        items: [{ id: 'operation-1', digest: 'sha256:payload' }],
        previews: [{
          id: 'operation-1',
          account_id: 'pilot-account',
          action: 'whatsapp.send',
          payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'held reply' } },
          digest: 'sha256:payload',
          state: 'held',
        }],
        expires_at: '2026-11-02T15:00:00.000Z',
      },
    };
    const { client, calls } = clientWith([response(200, review)]);

    await expect(client.registerInbound({
      eventId: 'inbound-review',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      text: '/review operation-1',
    })).resolves.toEqual({
      kind: 'review',
      review: {
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
      },
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      account_id: 'pilot-account',
      event_id: 'inbound-review',
      text: '/review operation-1',
    });
  });

  it('parses only the server-verified semantic mail preview, never the opaque Graph or MIME payload', async () => {
    // Break caught: Graph JSON can contain a different sender or attachment than
    // the canonical preview, so treating it as a human-readable review lies.
    const { client } = clientWith([response(200, {
      kind: 'review',
      review: {
        challenge: 'challenge-mail',
        items: [{ id: 'mail-operation-1', digest: 'sha256:mail-preview' }],
        previews: [{
          id: 'mail-operation-1',
          account_id: 'pilot-account',
          action: 'mail.send',
          payload: {
            graph_message_json: '{"from":"opaque-attacker@example.test","attachments":["opaque-secret.bin"]}',
            mime_base64: 'opaque-mime',
          },
          preview: {
            sender: 'sender@example.test',
            from: 'from@example.test',
            reply_to: ['reply@example.test'],
            subject: 'Reviewed subject',
            body: 'Reviewed body',
            content_type: 'HTML',
            to: ['to@example.test'],
            cc: ['cc@example.test'],
            bcc: ['bcc@example.test'],
            mailbox: 'me',
            attachments: [{
              index: 0,
              name: 'reviewed.pdf',
              size: 42,
              sha256: 'a'.repeat(64),
              content_type: 'application/pdf',
              is_inline: false,
              content_id: null,
            }],
            extra_headers: { 'x-reviewed': 'yes' },
          },
          digest: 'sha256:mail-preview',
          state: 'pending',
        }],
        expires_at: '2026-11-02T15:00:00.000Z',
      },
    })]);

    const result = await client.registerInbound({
      eventId: 'inbound-review-mail',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      text: '/review mail-operation-1',
    });

    expect(result).toMatchObject({
      kind: 'review',
      review: {
        previews: [{
          action: 'mail.send',
          preview: {
            sender: 'sender@example.test',
            attachments: [{ name: 'reviewed.pdf', sha256: 'a'.repeat(64) }],
            deskUrl: 'https://authority.example/operation-review',
          },
        }],
      },
    });
  });

  it('fails closed when a mail review lacks a complete preview or declares preview_error', async () => {
    // Break caught: an approval command is rendered despite the reviewer seeing
    // no semantic mail fields or a server-declared failure to verify them.
    const base = {
      id: 'mail-operation-1',
      account_id: 'pilot-account',
      action: 'mail.send',
      payload: { graph_message_json: '{"opaque":"payload"}' },
      digest: 'sha256:mail-preview',
      state: 'pending',
    };
    const review = (operation: Record<string, unknown>) => ({
      kind: 'review',
      review: {
        challenge: 'challenge-mail',
        items: [{ id: 'mail-operation-1', digest: 'sha256:mail-preview' }],
        previews: [operation],
        expires_at: '2026-11-02T15:00:00.000Z',
      },
    });
    const { client } = clientWith([
      response(200, review(base)),
      response(200, review({ ...base, preview_error: 'mail_preview_unavailable' })),
    ]);
    const inbound = {
      eventId: 'inbound-review-mail',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      text: '/review mail-operation-1',
    };

    await expect(client.registerInbound(inbound)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    await expect(client.registerInbound(inbound)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  it('defaults absent automation arrays to empty and parses exact approved WhatsApp automation', async () => {
    // Break caught: an agent learns a server-created operation but the client
    // drops its operation id or treats missing compatibility arrays as malformed.
    const { client } = clientWith([
      response(200, { kind: 'inbound' }),
      response(200, {
        kind: 'inbound',
        automation_operations: [{
          id: 'auto-whatsapp-1',
          account_id: 'pilot-account',
          action: 'whatsapp.send',
          payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'server-created' } },
          digest: 'sha256:auto',
          state: 'approved',
        }],
        automation_holds: [{ rule_id: 'rule-hold-1', reason: 'needs_review' }],
      }),
    ]);
    const inbound = {
      eventId: 'inbound-automation',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
    };

    await expect(client.registerInbound(inbound)).resolves.toEqual({
      kind: 'inbound', automationOperations: [], automationHolds: [],
    });
    await expect(client.registerInbound(inbound)).resolves.toEqual({
      kind: 'inbound',
      automationOperations: [{
        id: 'auto-whatsapp-1', accountId: 'pilot-account', action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'server-created' } },
        digest: 'sha256:auto', state: 'approved',
      }],
      automationHolds: [{ ruleId: 'rule-hold-1', reason: 'needs_review' }],
    });
  });

  it('accepts a paused response only with the authority-created fixed control receipt', async () => {
    // Break caught: a client manufactures a stop acknowledgement or accepts a
    // general paused-account send without an exact stored operation.
    const { client } = clientWith([response(200, {
      kind: 'paused',
      paused: true,
      generation: 4,
      in_flight_or_unknown: 0,
      receipt: {
        id: 'receipt-stop-1',
        account_id: 'pilot-account',
        action: 'whatsapp.control_receipt',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'Notifications paused.' } },
        digest: 'sha256:receipt',
        state: 'approved',
      },
    })]);

    await expect(client.registerInbound({
      eventId: 'inbound-stop',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
      text: '/stop',
    })).resolves.toEqual({
      kind: 'paused',
      receipt: {
        id: 'receipt-stop-1',
        accountId: 'pilot-account',
        action: 'whatsapp.control_receipt',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'Notifications paused.' } },
        digest: 'sha256:receipt',
        state: 'approved',
      },
    });
  });

  it('posts the protected inbound, pause, decision, and provider receipt records', async () => {
    // Break caught: sending a human decision through an unprotected generic-message path.
    const { client, calls } = clientWith([
      response(200, { kind: 'inbound' }),
      response(200, { closed: true }),
      response(200, { paused: true, generation: 3, in_flight_or_unknown: [] }),
      response(200, [{
        id: 'operation-1', account_id: 'pilot-account', action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'held reply' } },
        digest: 'sha256:payload', state: 'cancelled',
      }]),
      response(200, {
        id: 'operation-1', account_id: 'pilot-account', action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'held reply' } },
        digest: 'sha256:payload', state: 'provider_accepted',
        attempt_id: 'attempt-1', provider_id: 'wa-1',
      }),
    ]);

    await client.registerInbound({
      eventId: 'inbound-9',
      sender: '15551230000@s.whatsapp.net',
      conversation: '15551230000@s.whatsapp.net',
      receivedAt: '2026-11-02T14:30:00.000Z',
    });
    await client.closeInbound({ eventId: 'inbound-9' });
    await client.pause({ eventId: 'inbound-9' });
    await client.recordDecision({
      eventId: 'inbound-9',
      operationIds: ['operation-1'],
      digests: ['sha256:payload'],
      challenge: 'challenge-1',
      approve: false,
    });
    await client.recordReceipt({ attemptId: 'attempt-1', state: 'provider_accepted', providerId: 'wa-1' });

    expect(calls.map(({ url, init }) => ({ url, body: JSON.parse(String(init.body)) }))).toEqual([
      {
        url: 'https://authority.example/operations/transport/inbound',
        body: {
          account_id: 'pilot-account',
          event_id: 'inbound-9',
          sender: '15551230000@s.whatsapp.net',
          conversation: '15551230000@s.whatsapp.net',
          received_at: '2026-11-02T14:30:00.000Z',
        },
      },
      {
        url: 'https://authority.example/operations/transport/close',
        body: { account_id: 'pilot-account', event_id: 'inbound-9' },
      },
      {
        url: 'https://authority.example/operations/transport/pause',
        body: { account_id: 'pilot-account', event_id: 'inbound-9' },
      },
      {
        url: 'https://authority.example/operations/transport/decision',
        body: {
          account_id: 'pilot-account',
          event_id: 'inbound-9',
          operation_ids: ['operation-1'],
          digests: ['sha256:payload'],
          challenge: 'challenge-1',
          approve: false,
        },
      },
      {
        url: 'https://authority.example/operations/transport/receipts/attempt-1',
        body: { account_id: 'pilot-account', state: 'provider_accepted', provider_id: 'wa-1' },
      },
    ]);
  });

  it('fails closed on malformed 200 responses for pause, decision, and receipt writes', async () => {
    // Break caught: a proxy turns an authority write into an empty 200 and the
    // client reports a durable pause/decision/effect state that was never proven.
    const { client } = clientWith([response(200, {}), response(200, {}), response(200, {}), response(200, {})]);

    await expect(client.closeInbound({ eventId: 'inbound-1' })).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);

    await expect(client.pause({ eventId: 'inbound-1' })).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    await expect(client.recordDecision({
      eventId: 'inbound-1', operationIds: ['operation-1'], digests: ['sha256:payload'], challenge: 'challenge-1',
    })).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    await expect(client.recordReceipt({ attemptId: 'attempt-1', state: 'unknown' }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });
});

describe('createProtectedOperationsAuthorityClient', () => {
  it('rejects an enabled client when the service and worker identities are not distinct', () => {
    // Break caught: an agent worker could read the protected service credential file.
    const dir = tmpDirs.make('identities');
    const credentialFile = join(dir, 'transport.bearer');
    writeFileSync(credentialFile, 'token');
    chmodSync(credentialFile, 0o600);
    const serviceUid = process.getuid?.();
    if (serviceUid === undefined) return;

    expect(() => createProtectedOperationsAuthorityClient({
      baseUrl: 'https://authority.example',
      accountId: 'pilot-account',
      credentialFile,
      serviceUid,
      workerUid: serviceUid,
    })).toThrow(/distinct/);
  });

  it('rejects a credential file that is readable by another account', () => {
    // Break caught: permissive credential-file mode leaks a reusable transport bearer.
    const dir = tmpDirs.make('permissive-mode');
    const credentialFile = join(dir, 'transport.bearer');
    writeFileSync(credentialFile, 'token');
    chmodSync(credentialFile, 0o644);
    const serviceUid = process.getuid?.();
    if (serviceUid === undefined) return;

    expect(() => createProtectedOperationsAuthorityClient({
      baseUrl: 'https://authority.example',
      accountId: 'pilot-account',
      credentialFile,
      serviceUid,
      workerUid: serviceUid + 1,
    })).toThrow(/mode/);
  });

  it('constructs an operational client from a qualifying transport-service file without environment credentials', async () => {
    // Break caught: every enabled pilot is fail-closed because the concrete
    // factory cannot qualify a correctly owned, private service credential.
    const dir = tmpDirs.make('qualified-file');
    const credentialFile = join(dir, 'transport.bearer');
    writeFileSync(credentialFile, 'test-only-file-token\n');
    chmodSync(credentialFile, 0o600);
    const serviceUid = process.getuid?.();
    if (serviceUid === undefined) return;
    const fetch = vi.fn(async () => response(200, {
      attempt_id: 'attempt-from-file',
      payload_digest: 'sha256:file',
      state: 'dispatching',
    }));

    const client = createProtectedOperationsAuthorityClient({
      baseUrl: 'https://authority.example',
      accountId: 'pilot-account',
      credentialFile,
      serviceUid,
      workerUid: serviceUid + 1,
    }, { fetch, getuid: () => serviceUid });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'hello' } }))
      .resolves.toEqual({ attemptId: 'attempt-from-file', payloadDigest: 'sha256:file' });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer test-only-file-token' }),
    }));
  });
});
