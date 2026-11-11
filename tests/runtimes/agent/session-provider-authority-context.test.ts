import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/lib/process-identity.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/process-identity.ts')>(),
  probeProcessBirthToken: (pid: number) => pid === 51_001 ? 'linux-start:51001' : null,
}));

import { spawn } from 'node:child_process';
import { Database } from '../../../src/core/database.ts';
import {
  getTransportInboundContext,
  withTransportInboundContext,
} from '../../../src/core/transport-inbound-context.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { resetProcessTreeTerminationLeasesForTesting } from '../../../src/runtimes/agent/process-tree.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import type { ProviderSessionOptions } from '../../../src/runtimes/agent/providers/types.ts';

const CHAT_JID = 'provider-authority-context@s.whatsapp.net';
const openDatabases: Database[] = [];

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  ensureAgentSchema(db);
  openDatabases.push(db);
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

function makeSpawnPerTurnChild(bindRegisteredListeners = false, pid?: number) {
  const stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    write: vi.fn((...args: unknown[]) => {
      const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
      callback?.();
      return true;
    }),
  });
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
  });
  const child = {
    // Any supplied PID belongs to the mocked identity probe, never a host child.
    pid,
    stdin,
    stdout,
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
    _error: undefined as ((error: NodeJS.ErrnoException) => void) | undefined,
    _exit: undefined as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined,
    _close: undefined as ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined,
    on: vi.fn((event: string, callback: (...args: never[]) => void) => {
      const registeredCallback = bindRegisteredListeners
        ? AsyncLocalStorage.bind(callback)
        : callback;
      if (event === 'error') child._error = registeredCallback as typeof child._error;
      if (event === 'exit') child._exit = registeredCallback as typeof child._exit;
      if (event === 'close') child._close = registeredCallback as typeof child._close;
      return child;
    }),
  };
  return child;
}

describe('SessionManager persistent provider authority context', () => {
  afterEach(() => {
    resetProcessTreeTerminationLeasesForTesting();
    vi.restoreAllMocks();
    for (const db of openDatabases.splice(0)) db.close();
  });

  it('leaves reused managed-provider output, lifecycle, and crash callbacks unbound', async () => {
    const db = makeDb();
    const providerOptions: ProviderSessionOptions[] = [];
    const releaseTurns: Array<() => void> = [];
    const observed: Array<{ event: AgentEvent; inboundEventId: string | undefined }> = [];
    const crashContexts: Array<string | undefined> = [];

    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async (options) => {
      providerOptions.push(options);
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn').mockImplementation(() => new Promise<void>((resolve) => {
      releaseTurns.push(resolve);
    }));

    let session!: SessionManager;
    session = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      provider: 'openai-api',
      onEvent: (event) => {
        observed.push({
          event,
          inboundEventId: getTransportInboundContext()?.inbound_event_id,
        });
        if (event.type === 'result') session.completeProviderTurn(event.providerTurnOwnerToken);
      },
      onCrash: () => {
        crashContexts.push(getTransportInboundContext()?.inbound_event_id);
      },
    });

    const inboundA = { inbound_event_id: 'inbound-A' };
    const inboundB = { inbound_event_id: 'inbound-B', operation_id: 'operation-B' };
    let emitFromPersistentCallback!: (event: AgentEvent) => void;
    let crashFromPersistentCallback!: ProviderSessionOptions['onCrash'];
    await withTransportInboundContext(inboundA, async () => {
      await session.spawnSession();
      const options = providerOptions[0];
      if (options === undefined) throw new Error('managed provider callback was not initialized');
      emitFromPersistentCallback = AsyncLocalStorage.bind(options.onEvent);
      crashFromPersistentCallback = AsyncLocalStorage.bind(options.onCrash);
    });

    observed.length = 0;
    const turnA = withTransportInboundContext(inboundA, () => session.sendTurnAtProviderBoundary('turn A'));
    expect(releaseTurns).toHaveLength(1);
    emitFromPersistentCallback({ type: 'assistant_text', text: 'A output' });
    expect(observed).toEqual([
      expect.objectContaining({ inboundEventId: undefined }),
    ]);
    emitFromPersistentCallback({ type: 'result', text: 'A complete' });
    releaseTurns.shift()?.();
    await turnA;

    observed.length = 0;
    const turnB = withTransportInboundContext(inboundB, () => session.sendTurnAtProviderBoundary('turn B'));
    expect(releaseTurns).toHaveLength(1);
    // The provider's single retained callback still runs under the listener's
    // session-start context (A). It has no verified turn identity, so its
    // output must be explicitly unbound rather than attributed to B.
    emitFromPersistentCallback({ type: 'assistant_text', text: 'B output' });
    expect(observed).toEqual([
      expect.objectContaining({
        event: { type: 'assistant_text', text: 'B output' },
        inboundEventId: undefined,
      }),
    ]);
    emitFromPersistentCallback({ type: 'result', text: 'B complete' });
    releaseTurns.shift()?.();
    await turnB;

    observed.length = 0;
    emitFromPersistentCallback({ type: 'assistant_text', text: 'late output without a turn' });
    expect(observed).toEqual([
      expect.objectContaining({
        event: { type: 'assistant_text', text: 'late output without a turn' },
        inboundEventId: undefined,
      }),
    ]);

    observed.length = 0;
    emitFromPersistentCallback({ type: 'init', sessionId: 'lifecycle-after-turn' });
    expect(observed).toEqual([
      expect.objectContaining({
        event: { type: 'init', sessionId: 'lifecycle-after-turn' },
        inboundEventId: undefined,
      }),
    ]);

    crashFromPersistentCallback({
      exitCode: 1,
      signal: null,
      provider: 'openai-api',
      crashClass: 'test_crash',
    });
    expect(crashContexts).toEqual([undefined]);

  });

  it('clears a retained persistent child error notice after B has started', async () => {
    const db = makeDb();
    const child = makeSpawnPerTurnChild(true, 51_001);
    vi.mocked(spawn).mockReturnValue(child as never);
    const noticeContexts: Array<string | undefined> = [];
    const session = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: `${CHAT_JID}-notice`,
      provider: 'claude-cli',
      onEvent: () => {},
      notifyUser: () => {
        noticeContexts.push(getTransportInboundContext()?.inbound_event_id);
      },
    });

    const inboundA = { inbound_event_id: 'inbound-A' };
    const inboundB = { inbound_event_id: 'inbound-B' };
    await withTransportInboundContext(inboundA, () => session.spawnSession());
    expect(child._error).toBeTypeOf('function');

    await withTransportInboundContext(inboundB, () => session.sendTurnAtProviderBoundary('turn B'));
    child._error?.(Object.assign(new Error('missing cli'), { code: 'ENOENT' }) as NodeJS.ErrnoException);

    expect(noticeContexts).toEqual([undefined]);
  });

  it('restores B authority only for a callback captured with B token and generation', async () => {
    const db = makeDb();
    const child = makeSpawnPerTurnChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const observed: Array<{ event: AgentEvent; inboundEventId: string | undefined }> = [];
    let session!: SessionManager;
    session = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: `${CHAT_JID}-spawn`,
      provider: 'opencode-cli',
      model: 'glm/test-model',
      onEvent: (event) => {
        observed.push({
          event,
          inboundEventId: getTransportInboundContext()?.inbound_event_id,
        });
        if (event.type === 'result') session.completeProviderTurn(event.providerTurnOwnerToken);
      },
    });
    const inboundA = { inbound_event_id: 'inbound-A' };
    const inboundB = { inbound_event_id: 'inbound-B' };
    await withTransportInboundContext(inboundA, () => session.spawnSession());
    expect(observed).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'init' }),
        inboundEventId: undefined,
      }),
    ]);
    observed.length = 0;
    await withTransportInboundContext(inboundB, () => session.sendTurnAtProviderBoundary('turn B'));
    observed.length = 0;
    const emitAsA = withTransportInboundContext(inboundA, () => AsyncLocalStorage.bind((chunk: Buffer) => {
      child.stdout.emit('data', chunk);
    }));

    emitAsA(Buffer.from(`${JSON.stringify({ type: 'text', part: { text: 'B output' } })}\n`));
    emitAsA(Buffer.from(`${JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 1, output: 1 } },
    })}\n`));
    child._close?.(0, null);
    expect(observed).toEqual([
      expect.objectContaining({
        event: { type: 'assistant_text', text: 'B output' },
        inboundEventId: 'inbound-B',
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: 'result' }),
        inboundEventId: 'inbound-B',
      }),
    ]);
  });

  it('drops a stale per-turn callback after B replaces A token and child generation', async () => {
    const db = makeDb();
    const childA = makeSpawnPerTurnChild();
    const childB = makeSpawnPerTurnChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(childA as never)
      .mockReturnValueOnce(childB as never);
    const observed: Array<{ event: AgentEvent; inboundEventId: string | undefined }> = [];
    let session!: SessionManager;
    session = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: `${CHAT_JID}-stale`,
      provider: 'opencode-cli',
      model: 'glm/test-model',
      onEvent: (event) => {
        observed.push({
          event,
          inboundEventId: getTransportInboundContext()?.inbound_event_id,
        });
        if (event.type === 'result') session.completeProviderTurn(event.providerTurnOwnerToken);
      },
    });
    await session.spawnSession();

    const inboundA = { inbound_event_id: 'inbound-A' };
    const inboundB = { inbound_event_id: 'inbound-B' };
    await withTransportInboundContext(inboundA, () => session.sendTurnAtProviderBoundary('turn A'));
    childA.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'text', part: { text: 'A output' } })}\n`));
    childA.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 1, output: 1 } },
    })}\n`));
    childA._close?.(0, null);
    expect(session.getStatus().turnInFlight).toBe(false);

    observed.length = 0;
    await withTransportInboundContext(inboundB, () => session.sendTurnAtProviderBoundary('turn B'));
    const emitAAfterB = withTransportInboundContext(inboundA, () => AsyncLocalStorage.bind((chunk: Buffer) => {
      childA.stdout.emit('data', chunk);
    }));
    emitAAfterB(Buffer.from(`${JSON.stringify({ type: 'text', part: { text: 'late A output' } })}\n`));
    expect(observed).toEqual([]);

    const emitBFromA = withTransportInboundContext(inboundA, () => AsyncLocalStorage.bind((chunk: Buffer) => {
      childB.stdout.emit('data', chunk);
    }));
    emitBFromA(Buffer.from(`${JSON.stringify({ type: 'text', part: { text: 'B output' } })}\n`));
    emitBFromA(Buffer.from(`${JSON.stringify({
      type: 'step_finish',
      part: { reason: 'stop', tokens: { input: 1, output: 1 } },
    })}\n`));
    childB._close?.(0, null);
    expect(observed).toEqual([
      expect.objectContaining({ inboundEventId: 'inbound-B' }),
      expect.objectContaining({ inboundEventId: 'inbound-B' }),
    ]);
  });
});
