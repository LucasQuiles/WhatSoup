import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovedOperationDispatcher } from '../../src/transport/approved-operation-dispatcher.ts';
import { getTransportInboundContext, withTransportInboundContext } from '../../src/core/transport-inbound-context.ts';
import type { ReadyTransportReference, TransportOperation } from '../../src/transport/operations-authority-client.ts';
import { FinalTransportAuthorityGate } from '../../src/transport/operations-authority-gate.ts';
import { OutboundGovernor, wrapWithOutboundGovernor } from '../../src/transport/outbound-governor.ts';

const reference = { id: 'approved-file', digest: 'a'.repeat(64) };
const operation: TransportOperation = {
  ...reference, accountId: 'account', action: 'whatsapp.send', state: 'approved',
  payload: { recipient: 'recipient@s.whatsapp.net', content: { document: { $binary: 'bW1t' }, fileName: 'approved.txt' } },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const authority = {
    readyOperations: vi.fn(async (_signal?: AbortSignal): Promise<ReadyTransportReference[]> => []),
    readyOperation: vi.fn(async (_reference: ReadyTransportReference, _signal?: AbortSignal) => operation),
  };
  const send = vi.fn(async () => getTransportInboundContext());
  const onError = vi.fn();
  const dispatcher = new ApprovedOperationDispatcher({ accountId: 'account', authority, send, onError });
  return { authority, send, onError, dispatcher };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('ApprovedOperationDispatcher', () => {
  it('waits for approved work and clears ambient inbound authority', async () => {
    const { authority, send, dispatcher } = fixture();
    try {
      withTransportInboundContext({ inbound_event_id: 'expired-conversation' }, () => dispatcher.start());
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      authority.readyOperations.mockResolvedValueOnce([reference]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledExactlyOnceWith(operation.payload['recipient'], { document: Buffer.from('mmm'), fileName: 'approved.txt' }, undefined);
      await expect(send.mock.results[0]?.value).resolves.toEqual({ operation_id: reference.id });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { dispatcher.stop(); }
  });

  it('aborts a stopped discovery and ignores its late result', async () => {
    const { authority, send, dispatcher } = fixture();
    const read = deferred<ReadyTransportReference[]>();
    authority.readyOperations.mockReturnValueOnce(read.promise);
    dispatcher.start();
    const signal = authority.readyOperations.mock.calls[0]?.[0];
    dispatcher.stop();
    expect(signal?.aborted).toBe(true);
    read.resolve([reference]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(authority.readyOperation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(authority.readyOperations).toHaveBeenCalledTimes(1);
  });

  it('does not carry an old snapshot across stop and reconnect', async () => {
    const { authority, send, dispatcher } = fixture();
    const read = deferred<TransportOperation>();
    authority.readyOperations.mockResolvedValueOnce([reference]).mockResolvedValueOnce([reference]);
    authority.readyOperation.mockReturnValueOnce(read.promise);
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      dispatcher.stop();
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      read.resolve(operation);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { dispatcher.stop(); }
  });

  it('reports unavailable discovery and individual holds without blocking other approved items', async () => {
    const { authority, send, onError, dispatcher } = fixture();
    authority.readyOperations.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([
      { id: 'held', digest: 'b'.repeat(64) }, reference,
    ]);
    authority.readyOperation.mockRejectedValueOnce(new Error('approval revoked'));
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }), undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'approval revoked' }), 'held');
      expect(send).toHaveBeenCalledTimes(1);
    } finally { dispatcher.stop(); }
  });

  it('keeps discovery serial while an approved provider call is in flight', async () => {
    const authority = {
      readyOperations: vi.fn(async () => [reference]),
      readyOperation: vi.fn(async () => operation),
    };
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const dispatcher = new ApprovedOperationDispatcher({ accountId: 'account', authority, send, onError: vi.fn() });
    try {
      dispatcher.start();
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(authority.readyOperations).toHaveBeenCalledTimes(1);
      dispatcher.stop();
      pending.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(authority.readyOperations).toHaveBeenCalledTimes(1);
    } finally { pending.resolve(); dispatcher.stop(); }
  });

  it('blocks late admission from submitting after the connection stops', async () => {
    const admission = deferred<{ attemptId: string; payloadDigest: string }>();
    const authority = {
      readyOperations: vi.fn(async () => [reference]),
      readyOperation: vi.fn(async () => operation),
      admit: vi.fn(() => admission.promise),
      recordReceipt: vi.fn(async () => undefined),
    };
    const provider = vi.fn(async (_recipient: string, _content: unknown, _options?: Record<string, unknown>) => ({ key: { id: 'must-not-send' } }));
    const socket = { sendMessage: provider };
    wrapWithOutboundGovernor(socket, {
      governor: new OutboundGovernor({ windowMs: 1_000, maxPerWindow: 100, maxWaitMs: 10,
        hardCeiling: 100, hardCeilingWindowMs: 1_000, globalMaxPerWindow: 100, globalWindowMs: 1_000 }),
      resolveDest: (jid) => jid,
      authorityGate: new FinalTransportAuthorityGate(authority),
    });
    const dispatcher = new ApprovedOperationDispatcher({ accountId: 'account', authority,
      send: (...args) => socket.sendMessage(...args), onError: vi.fn() });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(authority.admit).toHaveBeenCalledTimes(1);
      dispatcher.stop();
      admission.resolve({ attemptId: 'late-admission', payloadDigest: reference.digest });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider).not.toHaveBeenCalled();
    } finally { dispatcher.stop(); }
  });

  it.each(['discovery', 'snapshot'] as const)('stops visibly when %s error reporting throws', async (stage) => {
    const { authority, send, onError, dispatcher } = fixture();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    if (stage === 'discovery') authority.readyOperations.mockRejectedValueOnce(new Error('offline'));
    else {
      authority.readyOperations.mockResolvedValueOnce([reference]);
      authority.readyOperation.mockRejectedValueOnce(new Error('revoked'));
    }
    onError.mockImplementation(() => { throw new Error('logger failed'); });
    try {
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(warning).toHaveBeenCalledWith('Approved transport dispatcher stopped because error reporting failed.',
        { code: 'TRANSPORT_DISPATCH_REPORTING_FAILED' });
      expect(authority.readyOperations).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally { dispatcher.stop(); warning.mockRestore(); }
  });
});
