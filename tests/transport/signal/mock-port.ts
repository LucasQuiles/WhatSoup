// tests/transport/signal/mock-port.ts
// Minimal in-memory SignalPort stub for adapter tests. Records every call and
// lets tests assert on the args + drive the poll loop deterministically.
//
// Modeled on the Twilio test mock-port pattern: the adapter talks to the
// interface; the stub records the calls and lets tests inject responses.
import type {
  SignalPort,
  SendSignalArgs,
  InboundSignal,
  ReactSignalArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
  SignalGroupMetadata,
} from '../../../src/transport/signal/port.ts';

export interface MockPortOptions {
  /** Records to return on the next listInboundSince call. */
  nextInbound?: readonly InboundSignal[];
  /** Error to throw from send(); if set, supersedes a successful return. */
  sendError?: Error;
  /** Error to throw from verifyCredentials(). */
  verifyError?: Error;
  /** Error to throw from listInboundSince(); if set, supersedes nextInbound. */
  listError?: Error;
}

export class MockSignalPort implements SignalPort {
  readonly sent: SendSignalArgs[] = [];
  readonly reactions: ReactSignalArgs[] = [];
  readonly receipts: SendReadReceiptArgs[] = [];
  readonly typings: SendTypingArgs[] = [];
  readonly groupQueries: string[] = [];
  /** Phase 6 — next getGroupMetadata result (mutated by tests). */
  nextGroup: SignalGroupMetadata | null = null;
  /** Phase 6 — error to throw from getGroupMetadata; supersedes nextGroup. */
  nextGroupError: Error | null = null;
  verifyCalls = 0;

  constructor(public opts: MockPortOptions = {}) {}

  async verifyCredentials(): Promise<void> {
    this.verifyCalls++;
    if (this.opts.verifyError) throw this.opts.verifyError;
  }

  async send(args: SendSignalArgs): Promise<{ timestamp: number }> {
    if (this.opts.sendError) throw this.opts.sendError;
    this.sent.push(args);
    return { timestamp: args.timestamp ?? (Date.now() + this.sent.length) };
  }

  async listInboundSince(_since: Date, _pageSize?: number): Promise<readonly InboundSignal[]> {
    if (this.opts.listError) throw this.opts.listError;
    const records = this.opts.nextInbound ?? [];
    // One-shot: clear after delivery so subsequent calls return empty.
    this.opts = { ...this.opts, nextInbound: undefined };
    return records;
  }

  async sendReaction(args: ReactSignalArgs): Promise<void> {
    this.reactions.push(args);
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    this.receipts.push(args);
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    this.typings.push(args);
  }

  async getGroupMetadata(groupId: string): Promise<SignalGroupMetadata> {
    this.groupQueries.push(groupId);
    if (this.nextGroupError) throw this.nextGroupError;
    if (!this.nextGroup) throw new Error('GROUP_NOT_FOUND');
    return this.nextGroup;
  }
}

/** Build a minimal config matching the SignalConfig shape with defaults applied. */
export function makeSignalConfig(overrides: Partial<import('../../../src/transport/signal/types.ts').SignalConfig> = {}):
  import('../../../src/transport/signal/types.ts').SignalConfig {
  return {
    account: 'test',
    socketPath: '/tmp/signalc-test.sock',
    phoneNumber: '+15551234567',
    inboundMode: 'poll',
    pollIntervalMs: 60000,
    rateLimit: { messagesPerMinute: 30 },
    ...overrides,
  };
}

/** Build a peer ConversationRef for the signal channel. */
export function peerConversationRef(
  channelId: import('../../../src/core/transport-refs.ts').ChannelId,
  peerId: string,
): import('../../../src/core/transport-refs.ts').ConversationRef {
  return { channel: channelId, id: peerId };
}
