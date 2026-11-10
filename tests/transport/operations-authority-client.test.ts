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
import { runWithTransportSendDeadline } from '../../src/transport/send-deadline.ts';
import { renderTransportReviewCard } from '../../src/transport/operations-authority-gate.ts';

type Call = { url: string; init: RequestInit };
const tmpDirs = trackTmpDirs('operations-authority-client');

function response(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function admissionResponse(): Record<string, string> {
  return {
    attempt_id: 'attempt-http-boundary',
    payload_digest: 'sha256:http-boundary',
    state: 'dispatching',
  };
}

function oversizedAuthorityResponse(cancel: () => void | Promise<void>): Response {
  const maxBytes = 100 * 1024 * 1024;
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","padding":"');
  const padding = new Uint8Array(1024 * 1024).fill(0x78);
  let emittedPrefix = false;
  let remainingChunks = maxBytes / padding.byteLength;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emittedPrefix) {
        emittedPrefix = true;
        controller.enqueue(prefix);
      } else if (remainingChunks > 0) {
        remainingChunks -= 1;
        controller.enqueue(padding);
      } else {
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      }
    },
    cancel,
  }));
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

describe('OperationsAuthorityClient HTTP boundaries', () => {
  it('reads a normal chunked authority response without following redirects', async () => {
    // Break caught: a bearer-authenticated authority call follows a redirect,
    // or a streamed success response no longer reaches the admission contract.
    const encoded = new TextEncoder().encode(JSON.stringify(admissionResponse()));
    const chunks = [encoded.subarray(0, 17), encoded.subarray(17)];
    const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }), { headers: { 'content-type': 'application/json' } }));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .resolves.toEqual({ attemptId: 'attempt-http-boundary', payloadDigest: 'sha256:http-boundary' });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects a redirect response before a bearer can reach another origin', async () => {
    // Break caught: redirect defaults forward the authority bearer to a URL
    // outside the configured authority origin.
    const fetch = vi.fn(async () => response(302, admissionResponse()));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects a chunked authority response above the 100-megabyte operation envelope', async () => {
    // Break caught: an authority response can consume unbounded memory before
    // its JSON contract is validated.
    const cancel = vi.fn();
    const fetch = vi.fn(async () => oversizedAuthorityResponse(cancel));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports an authority response cancellation failure', async () => {
    // Break caught: the client reports a bounded-response failure while hiding
    // a failed cancellation that can retain the authority response resources.
    const cancel = vi.fn(async () => { throw new Error('fixture cancellation failure'); });
    const fetch = vi.fn(async () => oversizedAuthorityResponse(cancel));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .rejects.toThrow('transport authority response cancellation failed');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an excessive number of empty and one-byte response chunks', async () => {
    // Break caught: a response stays below the byte cap but accumulates an
    // unbounded array of tiny chunk objects, including zero-byte chunks.
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    let emitted = 0;
    let reachedChunkLimit: (() => void) | undefined;
    const atChunkLimit = new Promise<void>((resolve) => { reachedChunkLimit = resolve; });
    const reader = {
      read: vi.fn(async () => {
        emitted += 1;
        if (emitted === 100_001) reachedChunkLimit?.();
        if (emitted > 100_001) return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
        return {
          done: false,
          value: emitted % 2 === 0 ? new Uint8Array(0) : new Uint8Array([0x20]),
        };
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const admission = client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      await atChunkLimit;
      await Promise.resolve();
      expect(reader.read).toHaveBeenCalledTimes(100_001);
      await expect(admission).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['nested', `[${'['.repeat(128)}0${']'.repeat(128)}]`],
    ['wide', `[${Array.from({ length: 100_000 }, () => '{}').join(',')}]`],
  ])('rejects a %s JSON structure before parsing the authority response', async (_kind, snapshot) => {
    // Break caught: JSON.parse allocates deeply nested or extremely wide
    // authority objects before the transport snapshot gate can reject them.
    const fetch = vi.fn(async () => new Response(`{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","snapshot":${snapshot}}`));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  it.each([
    ['scalar array', `[${'0,'.repeat(100_000)}0]`],
    ['object members', `{${Array.from({ length: 100_001 }, (_unused, index) => `"member_${index}":0`).join(',')}}`],
  ])('rejects %s that exceeds the response JSON token budget before parsing', async (_kind, snapshot) => {
    // Break caught: a flat response graph can avoid container/depth limits,
    // parse successfully, and be ignored by admission after allocating many
    // scalar values or object members.
    const fetch = vi.fn(async () => new Response(`{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","snapshot":${snapshot}}`));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  it('accepts a ten-thousand-node snapshot with long finite numbers', async () => {
    // Break caught: the preflight treats literal byte length as graph size and
    // rejects a snapshot the 10,000-node gate permits before JSON.parse.
    const finiteNumber = '-1.7976931348623157e+308';
    const snapshot = `[${Array.from({ length: 9_999 }, () => finiteNumber).join(',')}]`;
    const fetch = vi.fn(async () => new Response(`{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","snapshot":${snapshot}}`));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .resolves.toEqual({ attemptId: 'attempt-http-boundary', payloadDigest: 'sha256:http-boundary' });
  });

  it('accepts a bounded-depth response with a one-megabyte binary snapshot string', async () => {
    // Break caught: structural scanning treats quoted binary data as JSON
    // containers and rejects payload capacity the operation envelope permits.
    let nested = '"leaf"';
    for (let depth = 0; depth < 64; depth += 1) nested = `{"child":${nested}}`;
    const payload = `{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","snapshot":${nested},"binary":"${'A'.repeat(1024 * 1024)}"}`;
    const fetch = vi.fn(async () => new Response(payload));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    await expect(client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } }))
      .resolves.toEqual({ attemptId: 'attempt-http-boundary', payloadDigest: 'sha256:http-boundary' });
  });

  it.each([
    ['an escaped quote', '\\"', 'resolves'],
    ['three backslashes before a quote', '\\\\\\"', 'resolves'],
    ['an even backslash run that closes the string', '\\\\"', 'rejects'],
  ] as const)('scans structure after %s inside a response string', async (_kind, escape, outcome) => {
    // Break caught: the string skip must end a string only at a quote preceded
    // by an even backslash run. Ending too early counts quoted brackets as
    // containers; ending too late hides real nesting from the depth limit.
    const brackets = `${'['.repeat(129)}${']'.repeat(129)}`;
    const payload = outcome === 'resolves'
      ? `{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","note":"a${escape}${brackets}"}`
      : `{"attempt_id":"attempt-http-boundary","payload_digest":"sha256:http-boundary","state":"dispatching","note":"a${escape},"snapshot":${brackets}}`;
    const fetch = vi.fn(async () => new Response(payload));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    const parse = vi.spyOn(JSON, 'parse');
    try {
      const admission = client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      if (outcome === 'resolves') {
        await expect(admission).resolves.toEqual({ attemptId: 'attempt-http-boundary', payloadDigest: 'sha256:http-boundary' });
      } else {
        await expect(admission).rejects.toThrow('transport authority response is not JSON');
        // The structure scan, not a later gate, must reject the nesting.
        expect(parse.mock.calls.filter(([text]) => text === payload)).toEqual([]);
      }
    } finally {
      parse.mockRestore();
    }
  });

  it('returns at its own deadline when the authority response body stops streaming', async () => {
    // Break caught: a response starts successfully but then occupies the
    // transport gate forever while the body reader waits for another chunk.
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    let resolveLateRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"attempt_id":"partial"') })
        .mockImplementationOnce(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          resolveLateRead = resolve;
        })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return {
        status: 200,
        body: { getReader: () => reader },
      } as unknown as Response;
    });
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const admission = client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      const outcomePromise = admission.then(() => 'resolved', (error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await Promise.race([outcomePromise, Promise.resolve('still-pending')]);

      expect(outcome).toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(requestSignal?.aborted).toBe(true);
      expect(reader.cancel).toHaveBeenCalledOnce();
      resolveLateRead?.({ done: true, value: undefined });
      await Promise.resolve();
      expect(reader.read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a stalled reader when response cancellation never settles', async () => {
    // Break caught: an injected cancel() ignores the timed-out request and
    // retains the buffered response chunks and reader lock indefinitely.
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    let resolveLateRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"attempt_id":"partial"') })
        .mockImplementationOnce(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          resolveLateRead = resolve;
        })),
      cancel: vi.fn(() => new Promise<void>(() => {})),
      releaseLock: vi.fn(),
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return {
        status: 200,
        body: { getReader: () => reader },
      } as unknown as Response;
    });
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const admission = client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      const outcomePromise = admission.then(() => 'resolved', (error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await Promise.race([outcomePromise, Promise.resolve('still-pending')]);

      expect(outcome).toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(requestSignal?.aborted).toBe(true);
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
      resolveLateRead?.({ done: true, value: undefined });
      await Promise.resolve();
      expect(reader.read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns at its own deadline when an injected fetch ignores abort and rejects late', async () => {
    // Break caught: a test or adapter fetch implementation ignores AbortSignal,
    // leaving the authority gate waiting past its five-second client deadline.
    vi.useFakeTimers();
    let rejectFetch: ((reason: Error) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    });
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const admission = client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      const outcomePromise = admission.then(() => 'resolved', (error) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await Promise.race([
        outcomePromise,
        Promise.resolve('still-pending'),
      ]);

      expect(outcome).toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(requestSignal?.aborted).toBe(true);
      rejectFetch?.(new Error('late fake transport failure'));
      await Promise.resolve();
    } finally {
      rejectFetch?.(new Error('late fake transport failure'));
      vi.useRealTimers();
    }
  });

  it('observes the enclosing send deadline while waiting for authority admission', async () => {
    // Break caught: the transport deadline aborts, but authority admission
    // keeps running because the injected transport ignores its AbortSignal.
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const send = runWithTransportSendDeadline(() => client.admit({
        recipient: '15551230000@s.whatsapp.net',
        content: { text: 'fake-only' },
      }));
      const outcomePromise = send.then(() => 'resolved', (error) => error);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(outcomePromise).resolves.toBeInstanceOf(TransportAuthorityUnavailableError);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start authority admission after the enclosing send deadline has expired', async () => {
    // Break caught: an already-aborted contextual signal still invokes fetch,
    // creating authority work after the final transport deadline has elapsed.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const startAdmission = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const client = new OperationsAuthorityClient({
      baseUrl: 'https://authority.example/',
      accountId: 'pilot-account',
      bearerToken: 'test-only-transport-token',
      fetch,
    });

    try {
      const send = runWithTransportSendDeadline(async () => {
        await startAdmission;
        return client.admit({ recipient: '15551230000@s.whatsapp.net', content: { text: 'fake-only' } });
      });
      const outcomePromise = send.then(() => 'resolved', (error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcomePromise).resolves.toMatchObject({ code: 'SEND_TIMEOUT' });

      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OperationsAuthorityClient ingress and receipt contract', () => {
  it('discovers metadata and reads one exact approved transport operation', async () => {
    const reference = { id: 'ready-1', digest: 'a'.repeat(64) };
    const operation = { ...reference, account_id: 'pilot-account', action: 'whatsapp.send', state: 'approved',
      payload: { recipient: 'third-party@s.whatsapp.net', content: { document: { $binary: 'bW1t' } } } };
    const { client, calls } = clientWith([response(200, { items: [reference] }), response(200, { operation })]);
    await expect(client.readyOperations()).resolves.toEqual([reference]);
    await expect(client.readyOperation(reference)).resolves.toMatchObject({
      ...reference, accountId: 'pilot-account', state: 'approved', payload: operation.payload,
    });
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { account_id: 'pilot-account' },
      { account_id: 'pilot-account', operation_id: reference.id, payload_digest: reference.digest },
    ]);
    expect(calls.every((call) => call.url === 'https://authority.example/operations/transport/ready')).toBe(true);
  });

  it.each([
    { items: [{ id: 'one', digest: 'digest' }, { id: 'one', digest: 'digest' }] },
    { items: Array.from({ length: 101 }, (_, index) => ({ id: String(index), digest: 'digest' })) },
    { items: [{ id: 'one' }] },
    { items: [], operation: {} },
  ])('rejects malformed ready-work discovery: %j', async (body) => {
    const { client } = clientWith([response(200, body)]);
    await expect(client.readyOperations()).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  it.each([
    { id: 'different' }, { digest: 'different' }, { account_id: 'different' },
    { action: 'mail.send' }, { state: 'pending' }, { review_only: true },
  ])('rejects a changed or non-dispatchable ready snapshot: %j', async (changed) => {
    const reference = { id: 'ready-1', digest: 'a'.repeat(64) };
    const { client } = clientWith([response(200, { operation: {
      ...reference, account_id: 'pilot-account', action: 'whatsapp.send', state: 'approved',
      payload: { recipient: 'third-party@s.whatsapp.net', content: { text: 'reviewed' } }, ...changed,
    } })]);
    await expect(client.readyOperation(reference)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  const mediaInbound = {
    eventId: 'media-review', sender: '15551230000@s.whatsapp.net',
    conversation: '15551230000@s.whatsapp.net', receivedAt: '2026-11-02T14:30:00.000Z',
    text: '/review media-operation',
  };
  const mediaOperation = {
    id: 'media-operation', account_id: 'pilot-account', action: 'whatsapp.send',
    digest: 'a'.repeat(64), state: 'pending',
  };
  const mediaReview = (operation: Record<string, unknown>) => ({
    kind: 'review', review: {
      challenge: 'media-challenge', items: [{ id: 'media-operation', digest: 'a'.repeat(64) }],
      previews: [operation], expires_at: '2026-11-02T15:00:00.000Z',
      desk_url: 'https://untrusted.example/agent-controlled',
    },
  });

  it.each([3, 50 * 1024 * 1024])('routes legacy %i-byte media to the trusted Desk before serializing a card', async (size) => {
    const binary = Buffer.alloc(size, 109).toString('base64');
    const { client } = clientWith([response(200, mediaReview({
      ...mediaOperation, payload: { recipient: '15551230000@s.whatsapp.net', content: { document: { $binary: binary } } },
    }))]);
    const result = await client.registerInbound(mediaInbound);
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') throw new Error('expected a review');
    Object.defineProperty(result.review.previews[0]!.payload, 'toJSON', {
      value: () => { throw new Error('raw media must never be serialized into a human review card'); },
    });
    const card = renderTransportReviewCard(result.review);
    expect(card).toContain('https://authority.example/operation-review');
    expect(card).not.toContain('untrusted.example');
    expect(card).not.toContain('/approve');
    expect(card).not.toContain('/reject');
    expect(card).not.toContain('$binary');
    expect(card).not.toContain(binary.slice(0, 20));
    expect(card.length).toBeLessThan(1000);
  });

  it('accepts a payload-free media review only as a Desk referral', async () => {
    const { client } = clientWith([response(200, mediaReview({
      ...mediaOperation, review_only: true,
      preview: { recipient: '15551230000@s.whatsapp.net', attachments: [{ index: 0, size: 3, sha256: 'b'.repeat(64) }] },
    }))]);
    const result = await client.registerInbound(mediaInbound);
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') throw new Error('expected a review');
    expect(result.review.previews[0]).toMatchObject({ reviewOnly: true, payload: {} });
    const card = renderTransportReviewCard(result.review);
    expect(card).toContain('https://authority.example/operation-review');
    expect(card).not.toContain('/approve');
  });

  it('reads the authority millisecond review expiry without weakening malformed-value rejection', async () => {
    const review = mediaReview({
      ...mediaOperation, review_only: true,
      preview: { recipient: '15551230000@s.whatsapp.net', attachments: [{ index: 0, size: 3, sha256: 'b'.repeat(64) }] },
    });
    const { client } = clientWith([
      response(200, { ...review, review: { ...review.review, expires_at: 1793750400000 } }),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER, null, true].map((expires_at) => response(200, { ...review, review: { ...review.review, expires_at } })),
    ]);
    const result = await client.registerInbound(mediaInbound);
    expect(result).toMatchObject({ kind: 'review', review: { expiresAt: '2026-11-04T00:00:00.000Z' } });
    for (let index = 0; index < 5; index += 1) {
      await expect(client.registerInbound(mediaInbound)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
    }
  });

  it.each([
    { review_only: false },
    { state: 'approved' },
    { action: 'whatsapp.control_receipt' },
    { payload: {} },
    { preview: { recipient: '15551230000@s.whatsapp.net', attachments: [] } },
    { preview: { recipient: '', attachments: [{ index: 0 }] } },
  ])('rejects malformed media review projections: %j', async (invalid) => {
    const { client } = clientWith([response(200, mediaReview({
      ...mediaOperation, review_only: true,
      preview: { recipient: '15551230000@s.whatsapp.net', attachments: [{ index: 0 }] },
      ...invalid,
    }))]);
    await expect(client.registerInbound(mediaInbound)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

  it('holds mixed reviews with nested binary options when no trusted Desk is available', async () => {
    const { client } = clientWith([response(200, mediaReview({
      ...mediaOperation, payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'caption' },
        options: { nested: { thumbnail: { $binary: 'bW1t' } } } },
    }))]);
    const result = await client.registerInbound(mediaInbound);
    if (result.kind !== 'review') throw new Error('expected a review');
    const textOperation = { ...result.review.previews[0]!, id: 'text-operation', payload: { content: { text: 'ordinary' } } };
    result.review.previews.unshift(textOperation);
    result.review.items.unshift({ id: textOperation.id, digest: textOperation.digest });
    expect(renderTransportReviewCard(result.review)).not.toContain('/approve');
    delete result.review.deskUrl;
    expect(() => renderTransportReviewCard(result.review)).toThrow(TransportAuthorityUnavailableError);
  });

  it.each(['decision', 'inbound', 'paused'])('rejects a review-only record in the %s execution response', async (kind) => {
    const operation = { ...mediaOperation, state: 'approved', review_only: true,
      payload: { recipient: '15551230000@s.whatsapp.net', content: { text: 'must not dispatch' } } };
    const { client } = clientWith([response(200, { kind, operations: [operation], automation_operations: [operation], receipt: operation })]);
    await expect(client.registerInbound(mediaInbound)).rejects.toBeInstanceOf(TransportAuthorityUnavailableError);
  });

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
        deskUrl: 'https://authority.example/operation-review',
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
