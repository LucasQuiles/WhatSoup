// tests/transport/imessage/mock-port.ts
// Minimal in-memory ImessagePort stub for adapter tests.
import type {
  ImessagePort,
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
  private nextGuid = 1;

  constructor(private opts: MockPortOptions = {}) {}

  async verifyCredentials(): Promise<void> {
    this.verifyCalls++;
    if (this.opts.verifyError) throw this.opts.verifyError;
  }

  async send(args: SendImessageArgs): Promise<{ guid: string }> {
    if (this.opts.sendError) throw this.opts.sendError;
    this.sent.push(args);
    return { guid: `guid-${this.nextGuid++}` };
  }

  async listInboundSince(_since: Date, _pageSize?: number): Promise<readonly InboundImessage[]> {
    const records = this.opts.nextInbound ?? [];
    this.opts = { ...this.opts, nextInbound: undefined };
    return records;
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
