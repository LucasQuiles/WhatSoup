import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import { ChatQueue } from '../../../src/runtimes/chat/queue.ts';
import { ChatRuntime } from '../../../src/runtimes/chat/runtime.ts';
import type { LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../src/runtimes/chat/providers/pinecone.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../../src/lib/model-advisor.ts', () => ({
  resolveModelRole: vi.fn(async (role: string) => role),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  clearAlertSourceChecked: vi.fn(),
  emitAlertChecked: vi.fn(),
}));

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'message-1',
    chatJid: 'chat-1@s.whatsapp.net',
    senderJid: 'sender-1@s.whatsapp.net',
    senderName: null,
    content: 'hello',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: 1_700_000_000,
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function makeProvider(): LLMProvider {
  return {
    name: 'test-provider',
    generate: vi.fn().mockResolvedValue({
      content: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      model: 'test-model',
      durationMs: 1,
    }),
  };
}

function makePinecone(): PineconeMemory {
  return {
    searchForChat: vi.fn().mockResolvedValue([]),
    searchForSender: vi.fn().mockResolvedValue([]),
    searchSelfFacts: vi.fn().mockResolvedValue([]),
    searchEntities: vi.fn().mockResolvedValue([]),
  } as unknown as PineconeMemory;
}

describe('ChatRuntime queue admission', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeRuntime(queue: ChatQueue): {
    runtime: ChatRuntime;
    messenger: Messenger;
    fallbackProvider: LLMProvider;
    primaryProvider: LLMProvider;
  };
  function makeRuntime(
    queue: ChatQueue,
    overrides: {
      messenger?: Messenger;
      primaryProvider?: LLMProvider;
      fallbackProvider?: LLMProvider;
    },
  ): {
    runtime: ChatRuntime;
    messenger: Messenger;
    fallbackProvider: LLMProvider;
    primaryProvider: LLMProvider;
  };
  function makeRuntime(
    queue: ChatQueue,
    overrides: {
      messenger?: Messenger;
      primaryProvider?: LLMProvider;
      fallbackProvider?: LLMProvider;
    } = {},
  ) {
    const messenger = overrides.messenger ?? makeMessenger();
    const primaryProvider = overrides.primaryProvider ?? makeProvider();
    const fallbackProvider = overrides.fallbackProvider ?? makeProvider();
    const runtime = new ChatRuntime(
      db,
      messenger,
      makePinecone(),
      primaryProvider,
      fallbackProvider,
      { enableEnrichment: false, chatQueue: queue },
    );
    runtime.setDurability(durability);
    return { runtime, messenger, fallbackProvider, primaryProvider };
  }

  it('terminalizes a capacity-rejected journaled inbound before returning its receipt', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime, fallbackProvider, primaryProvider } = makeRuntime(queue);
    const inboundSeq = durability.journalInbound(
      'message-2',
      'conversation-1',
      'chat-1@s.whatsapp.net',
      'chat',
    );

    const receipt = await runtime.handleMessage(makeMessage({
      messageId: 'message-2',
      inboundSeq,
    }));

    expect(receipt).toEqual({
      status: 'rejected',
      reason: 'queue_full',
      durableDisposition: 'failed',
    });
    expect(queue.droppedCount).toBe(1);
    expect(primaryProvider.generate).not.toHaveBeenCalled();
    expect(fallbackProvider.generate).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      `SELECT processing_status, failure_class, terminal_reason
       FROM inbound_events
       WHERE seq = ?`,
    ).get(inboundSeq)).toEqual({
      processing_status: 'failed',
      failure_class: 'queue_full',
      terminal_reason: 'error',
    });
    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'healthy',
      details: {
        queueAdmission: {
          rejectedTotal: 1,
          unownedTotal: 0,
        },
      },
    });
  });

  it('returns an accepted receipt without waiting for admitted work to complete', async () => {
    const queue = new ChatQueue(1, 1);
    let signalGenerateStarted!: () => void;
    let releaseGenerate!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      signalGenerateStarted = resolve;
    });
    const generateResult = new Promise<Awaited<ReturnType<LLMProvider['generate']>>>((resolve) => {
      releaseGenerate = () => resolve({
        content: 'accepted response',
        inputTokens: 1,
        outputTokens: 1,
        model: 'test-model',
        durationMs: 1,
      });
    });
    const primaryProvider: LLMProvider = {
      name: 'deferred-provider',
      generate: vi.fn(async () => {
        signalGenerateStarted();
        return generateResult;
      }),
    };
    const { runtime, messenger } = makeRuntime(queue, { primaryProvider });
    await runtime.start();
    const inboundSeq = durability.journalInbound(
      'message-accepted',
      'chat-1@s.whatsapp.net',
      'chat-1@s.whatsapp.net',
      'chat',
    );

    await expect(runtime.handleMessage(makeMessage({
      messageId: 'message-accepted',
      inboundSeq,
    }))).resolves.toEqual({
      status: 'accepted',
    });
    await generateStarted;
    expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(queue.stats.trackedChats).toBe(1);

    releaseGenerate();
    await vi.waitFor(() => {
      expect(messenger.sendMessage).toHaveBeenCalledOnce();
      expect(durability.getInboundStatus(inboundSeq)).toBe('complete');
      expect(queue.stats.trackedChats).toBe(0);
    });
    expect(queue.droppedCount).toBe(0);
    await runtime.shutdown();
  });

  it('rejects instead of returning a false durable receipt when terminalization fails', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(queue);
    const inboundSeq = durability.journalInbound(
      'message-terminal-write-failure',
      'conversation-1',
      'chat-1@s.whatsapp.net',
      'chat',
    );
    vi.spyOn(durability, 'markInboundFailedIfProcessing').mockImplementation(() => {
      throw new Error('terminal write failed');
    });

    await expect(runtime.handleMessage(makeMessage({
      messageId: 'message-terminal-write-failure',
      inboundSeq,
    }))).rejects.toThrow('terminal write failed');
    expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'degraded',
      details: {
        queueAdmission: {
          rejectedTotal: 1,
          unownedTotal: 1,
        },
      },
    });
  });

  it('rejects and degrades health when no linked inbound row can be terminalized', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(queue);

    await expect(runtime.handleMessage(makeMessage({
      messageId: 'message-missing-inbound',
      inboundSeq: 9_999,
    }))).rejects.toThrow('Queue rejection terminalization did not update an inbound row');
    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'degraded',
      details: {
        queueAdmission: {
          rejectedTotal: 1,
          unownedTotal: 1,
        },
      },
    });
  });

  it('does not overwrite an already-terminal inbound row with queue_full', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(queue);
    const inboundSeq = durability.journalInbound(
      'message-already-terminal',
      'conversation-1',
      'chat-1@s.whatsapp.net',
      'chat',
    );
    durability.markInboundSkipped(inboundSeq, 'passive_instance');

    await expect(runtime.handleMessage(makeMessage({
      messageId: 'message-already-terminal',
      inboundSeq,
    }))).rejects.toThrow('Queue rejection terminalization did not update an inbound row');
    expect(durability.getInboundStatus(inboundSeq)).toBe('complete');
    expect(db.raw.prepare(
      'SELECT terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      terminal_reason: 'passive_instance',
      failure_class: null,
    });
  });

  it('does not terminalize a different processing inbound through a stale sequence', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(queue);
    const otherInboundSeq = durability.journalInbound(
      'message-owned-by-another-call',
      'conversation-1',
      'chat-1@s.whatsapp.net',
      'chat',
    );

    await expect(runtime.handleMessage(makeMessage({
      messageId: 'message-with-stale-sequence',
      inboundSeq: otherInboundSeq,
    }))).rejects.toThrow('Queue rejection terminalization did not update an inbound row');
    expect(durability.getInboundStatus(otherInboundSeq)).toBe('processing');
  });

  it('keeps the queue bounded and sends no reply across repeated rejections', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime, messenger, fallbackProvider, primaryProvider } = makeRuntime(queue);
    const inboundSeqs = [
      durability.journalInbound('message-repeat-1', 'conversation-1', 'chat-1@s.whatsapp.net', 'chat'),
      durability.journalInbound('message-repeat-2', 'conversation-1', 'chat-1@s.whatsapp.net', 'chat'),
    ];

    for (const [index, inboundSeq] of inboundSeqs.entries()) {
      await expect(runtime.handleMessage(makeMessage({
        messageId: `message-repeat-${index + 1}`,
        inboundSeq,
      }))).resolves.toEqual({
        status: 'rejected',
        reason: 'queue_full',
        durableDisposition: 'failed',
      });
    }

    expect(queue.droppedCount).toBe(2);
    expect(queue.stats.trackedChats).toBe(1);
    expect(inboundSeqs.map((seq) => durability.getInboundStatus(seq))).toEqual([
      'failed',
      'failed',
    ]);
    expect(primaryProvider.generate).not.toHaveBeenCalled();
    expect(fallbackProvider.generate).not.toHaveBeenCalled();
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(messenger.sendMedia).not.toHaveBeenCalled();
  });

  it('reports an unowned rejection as bounded degraded health evidence', async () => {
    const queue = new ChatQueue(1, 1);
    await queue.enqueue('chat-1@s.whatsapp.net', () => new Promise<void>(() => {}));
    const { runtime } = makeRuntime(queue);

    await expect(runtime.handleMessage(makeMessage())).resolves.toEqual({
      status: 'rejected',
      reason: 'queue_full',
      durableDisposition: 'unowned',
    });

    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'degraded',
      details: {
        queue: {
          droppedCount: 1,
        },
        queueAdmission: {
          rejectedTotal: 1,
          unownedTotal: 1,
        },
      },
    });
  });
});
