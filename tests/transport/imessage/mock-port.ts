// tests/transport/imessage/mock-port.ts
// Minimal in-memory ImessagePort stub for adapter tests.
import type {
  ImessagePort,
  InboundImessagePage,
  SendImessageArgs,
  InboundImessage,
  ReactImessageArgs,
  SendReadReceiptArgs,
  SendTypingArgs,
} from '../../../src/transport/imessage/port.ts';

export interface MockPortOptions {
  readonly nextInbound?: readonly InboundImessage[];
  readonly sendError?: Error;
  readonly verifyError?: Error;
}

export class MockImessagePort implements ImessagePort {
  readonly sent: SendImessageArgs[] = [];
  readonly reactions: ReactImessageArgs[] = [];
  readonly receipts: SendReadReceiptArgs[] = [];
  readonly typings: SendTypingArgs[] = [];
  verifyCalls = 0;
  disposeCalls = 0;
  private nextGuid = 1;

  constructor(private opts: MockPortOptions = {}) {}

  async verifyCredentials(): Promise<void> {
    this.verifyCalls++;
    if (this.opts.verifyError) throw this.opts.verifyError;
  }

  /** #2322 H2: mirrors ImsgPort.dispose() — call count only, no real socket. */
  dispose(): void {
    this.disposeCalls++;
  }

  async send(args: SendImessageArgs): Promise<{ guid: string }> {
    if (this.opts.sendError) throw this.opts.sendError;
    this.sent.push(args);
    return { guid: `guid-${this.nextGuid++}` };
  }

  async listInboundSince(
    _since: Date,
    _pageSize?: number,
    _cursor?: string | null,
  ): Promise<InboundImessagePage> {
    const records = this.opts.nextInbound ?? [];
    this.opts = { ...this.opts, nextInbound: undefined };
    return { records, cursor: 'mock:idle', hasMore: false };
  }

  async sendReaction(args: ReactImessageArgs): Promise<void> {
    this.reactions.push(args);
  }

  async sendReadReceipts(args: SendReadReceiptArgs): Promise<void> {
    this.receipts.push(args);
  }

  async sendTypingIndicator(args: SendTypingArgs): Promise<void> {
    this.typings.push(args);
  }
}

export function imessagePage(
  records: readonly InboundImessage[],
  nextOffset: number | null = null,
): InboundImessagePage {
  return {
    records,
    cursor: nextOffset === null ? 'mock:complete' : `mock:offset:${nextOffset}`,
    hasMore: nextOffset !== null,
  };
}

export function imessageCursorOffset(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  const match = /^mock:offset:(\d+)$/.exec(cursor);
  if (match === null) return 0;
  return Number(match[1]);
}

import type { ImessageConfig } from '../../../src/transport/imessage/types.ts';

export function makeImessageConfig(overrides: Partial<ImessageConfig> = {}): ImessageConfig {
  return {
    account: 'test',
    backend: 'bluebubbles',
    bluebubblesUrl: 'https://bb.example.test',
    bluebubblesPasswordService: 'imsg-bb-test',
    sender: 'bot@example.com',
    inboundMode: 'poll',
    pollIntervalMs: 60000,
    rateLimit: { messagesPerMinute: 30 },
    ...overrides,
  };
}

import type { ChannelId, ConversationRef } from '../../../src/core/transport-refs.ts';

export function peerConversationRef(channelId: ChannelId, peerId: string): ConversationRef {
  return { channel: channelId, id: peerId };
}
