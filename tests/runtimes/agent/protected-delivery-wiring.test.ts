import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { ProtectedDeliveryService } from '../../../src/core/protected-delivery.ts';
import type { Messenger } from '../../../src/core/types.ts';

const { registerAllTools } = vi.hoisted(() => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-protected-delivery/tmp',
    stateRoot: '/tmp/whatsoup-test-protected-delivery/state',
    dataRoot: '/tmp/whatsoup-test-protected-delivery/data',
    fleetLifecyclePhase: 'shadow',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  },
}));
vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(), emitAlertChecked: vi.fn(() => true), emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(), clearAlertSourceChecked: vi.fn(),
}));
vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools }));
vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class { register = vi.fn(); listTools = vi.fn(() => []); call = vi.fn(); getChatScopedToolNames = vi.fn(() => []); setDurability = vi.fn(); },
}));
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({ verifyFallbackCredential: vi.fn(async () => 'unknown') }));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(async () => ({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(async () => ({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

function makeDb(): Database {
  return { assertWritableCompatibility: vi.fn(), raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() } } as unknown as Database;
}

function makeMessenger(): Messenger {
  return { sendMessage: vi.fn(async () => ({ waMessageId: null })), sendMedia: vi.fn(async () => ({ waMessageId: null })) } as unknown as Messenger;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
});

describe('AgentRuntime protected-delivery registration', () => {
  it('passes an injected protected delivery service to the canonical registry', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const service = {} as ProtectedDeliveryService;

    new AgentRuntime(db, messenger, 'protected-test', { protectedDeliveryService: service });

    expect(registerAllTools).toHaveBeenCalledOnce();
    const [registry, registeredMessenger, registeredDb, options] = registerAllTools.mock.calls[0]!;
    expect(typeof registry).toBe('object');
    expect(registeredMessenger).toBe(messenger);
    expect(registeredDb).toBe(db);
    expect(options?.protectedDeliveryService).toBe(service);
  });

  it('leaves the protected surface absent by default', () => {
    new AgentRuntime(makeDb(), makeMessenger(), 'protected-test');

    expect(registerAllTools).toHaveBeenCalledOnce();
    const [, , , options] = registerAllTools.mock.calls[0]!;
    expect(options).not.toHaveProperty('protectedDeliveryService');
  });
});
