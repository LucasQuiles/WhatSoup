import { expect, it, vi, type Mock } from 'vitest';
import type { ConnectionManager } from '../../../src/transport/connection.ts';
import {
  TransportAuthorityUnavailableError,
  type TransportAdmissionInput,
  type TransportReceiptInput,
} from '../../../src/transport/operations-authority-client.ts';

interface Fixture {
  manager: ConnectionManager;
  send: Mock;
  open(): void;
  inbound(): void;
}

export function defineInboundAutomationIsolationCases(create: () => Fixture): void {
  it.each(['pending', 'unknown', 'already_claimed', 'paused'] as const)(
    'ingests ordinary input independently of %s automation dispatch',
    async (outcome) => {
      // Break caught: an inline automation await prevents a registered input
      // reaching ingestion when delivery blocks, fails, or loses its claim.
      const { manager, send, open, inbound } = create();
      const operations = ['first', 'second'].map((id) => ({
        id, accountId: 'pilot-account', action: 'whatsapp.send',
        payload: { recipient: '15551230000@s.whatsapp.net', content: { text: id } },
        digest: `sha256:${id}`, state: 'approved',
      }));
      const states = new Map(operations.map(({ id }) => [id, 'approved']));
      let ready = outcome === 'already_claimed';
      let release!: () => void;
      const held = new Promise<{ key: { id: string } }>((resolve) => {
        release = () => resolve({ key: { id: 'first-provider-id' } });
      });
      send.mockImplementation(async (_recipient: string, content: { text: string }) => {
        if (content.text === 'first') {
          if (outcome === 'unknown') throw new Error('provider disconnected after submission');
          return held;
        }
        return { key: { id: 'second-provider-id' } };
      });
      const authority = {
        readyOperations: vi.fn(async () => ready
          ? operations.filter(({ id }) => states.get(id) === 'approved')
            .map(({ id, digest }) => ({ id, digest })) : []),
        readyOperation: vi.fn(async ({ id }: { id: string }) => {
          const operation = operations.find((item) => item.id === id);
          if (!operation) throw new Error('unexpected ready reference');
          return operation;
        }),
        registerInbound: vi.fn(async () => {
          ready = true;
          return {
            kind: 'inbound' as const,
            automationOperations: [...operations, {
              id: 'mail', accountId: 'pilot-account', action: 'mail.send',
              payload: { subject: 'mail executor only' }, digest: 'sha256:mail', state: 'approved',
            }],
            automationHolds: [{ ruleId: 'held-rule', reason: 'needs_review' }],
          };
        }),
        closeInbound: vi.fn(async () => undefined),
        admit: vi.fn(async ({ operationId }: TransportAdmissionInput) => {
          if (!operationId || states.get(operationId) !== 'approved') {
            throw new TransportAuthorityUnavailableError('already_claimed');
          }
          if (outcome === 'paused') throw new TransportAuthorityUnavailableError('account_paused');
          states.set(operationId, 'dispatching');
          return { attemptId: operationId, payloadDigest: `sha256:${operationId}` };
        }),
        recordReceipt: vi.fn(async ({ attemptId, state }: TransportReceiptInput) => {
          states.set(attemptId, state);
        }),
        recordDecision: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
      };
      const ingested: string[] = [];
      manager.setOperationsAuthorityClient(authority);
      manager.onMessage = (message) => { ingested.push(message.messageId); };
      try {
        await manager.connect();
        open();
        await vi.advanceTimersByTimeAsync(0);
        if (outcome === 'already_claimed') expect(send).toHaveBeenCalledTimes(1);
        inbound();
        await vi.advanceTimersByTimeAsync(0);
        expect(ingested).toEqual(['inbound-auto']);
        expect(authority.closeInbound).toHaveBeenCalledExactlyOnceWith({ eventId: 'inbound-auto' });
        // A newly registered operation waits for the existing consumer; the
        // ordinary callback neither claims it nor waits for its provider call.
        expect(authority.admit).toHaveBeenCalledTimes(outcome === 'already_claimed' ? 1 : 0);
        await vi.advanceTimersByTimeAsync(1_000);
        release();
        await vi.advanceTimersByTimeAsync(0);
        if (outcome === 'paused') {
          expect(send).not.toHaveBeenCalled();
          expect(authority.recordReceipt).not.toHaveBeenCalled();
        } else {
          expect(send).toHaveBeenCalledTimes(2);
          expect(send).toHaveBeenNthCalledWith(1, '15551230000@s.whatsapp.net', { text: 'first' });
          expect(send).toHaveBeenNthCalledWith(2, '15551230000@s.whatsapp.net', { text: 'second' });
          expect(authority.recordReceipt).toHaveBeenCalledWith({
            attemptId: 'second', state: 'provider_accepted', providerId: 'second-provider-id',
          });
          if (outcome === 'unknown') {
            expect(authority.recordReceipt).toHaveBeenCalledWith({ attemptId: 'first', state: 'unknown' });
          }
          const claims = authority.admit.mock.calls.length;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(authority.admit).toHaveBeenCalledTimes(claims);
          expect(send).toHaveBeenCalledTimes(2);
        }
        for (const [claim] of authority.admit.mock.calls) expect(claim.context).toBeUndefined();
        expect(ingested).toEqual(['inbound-auto']);
      } finally {
        release();
        await manager.shutdown();
      }
    },
  );
}
