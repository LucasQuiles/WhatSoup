import { afterEach, describe, expect, it, vi } from 'vitest';

const { createChildLogger } = vi.hoisted(() => ({
  createChildLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../../src/logger.ts', () => ({ createChildLogger }));

import { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import {
  buildEmitHealResultTool,
  registerRuntimeInlineTools,
  type EmitHealResultToolDeps,
  type RuntimeInlineToolsDeps,
} from '../../../src/runtimes/agent/runtime-tool-registrations.ts';
import type { RestartSelfToolDeps } from '../../../src/runtimes/agent/self-restart.ts';

const LOOPS_PHONE = '15551112222';

it('preserves the agent-runtime component identity after extraction', () => {
  expect(createChildLogger).toHaveBeenCalledWith('agent-runtime');
});

function fakeQueue() {
  const sendControlMessage = vi.fn<(targetJid: string, protocol: string, payload: unknown, durability?: unknown) => Promise<void>>(
    async () => {},
  );
  return { queue: { sendControlMessage } as unknown as ControlQueue, sendControlMessage };
}

function fakeDb() {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ run }));
  return { db: { raw: { prepare } } as unknown as Database, prepare, run };
}

function healDeps(overrides: Partial<EmitHealResultToolDeps> = {}): EmitHealResultToolDeps {
  return {
    getActiveControlReportId: () => 'R1',
    isControlReportCompleted: () => false,
    markControlReportCompleted: vi.fn(),
    getControlQueue: () => fakeQueue().queue,
    getDurability: () => null,
    messenger: {} as unknown as Messenger,
    db: fakeDb().db,
    controlPeers: new Map([['loops', LOOPS_PHONE]]),
    adminPhones: new Set<string>(),
    ...overrides,
  };
}

function params(result: 'fixed' | 'escalate', reportId = 'R1') {
  return { reportId, errorClass: 'provider.timeout', result, diagnosis: 'diag text' };
}

/** Minimal RestartSelfToolDeps — buildRestartSelfTool never invokes these at build time. */
function restartDeps(): RestartSelfToolDeps {
  return {
    instanceName: 'inst',
    dataRoot: '/tmp/dr',
    resolveChatJid: () => undefined,
    sendAck: async () => {},
    serviceManager: { restart: async () => {} },
    trigger: async () => ({ ok: true, markerPath: '/tmp/dr/marker' }),
    assertAdmin: () => {},
  };
}

function fakeRegistry() {
  const names: string[] = [];
  const registry = { register: (tool: { name: string }) => { names.push(tool.name); } } as unknown as ToolRegistry;
  return { registry, names };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildEmitHealResultTool declaration', () => {
  it('mirrors the inline registration surface (name, scope, non-core, unsafe replay)', () => {
    const tool = buildEmitHealResultTool(healDeps());
    expect(tool.name).toBe('emit_heal_result');
    expect(tool.scope).toBe('global');
    expect(tool.core).toBe(false);
    expect(tool.replayPolicy).toBe('unsafe');
    expect(tool.targetMode).toBe('caller-supplied');
  });
});

describe('emit_heal_result handler guards', () => {
  it('rejects when no repair session is active', async () => {
    const tool = buildEmitHealResultTool(healDeps({ getActiveControlReportId: () => null }));
    await expect(tool.handler(params('fixed'), {} as never)).rejects.toThrow('No active repair session');
  });

  it('rejects a mismatched reportId', async () => {
    const tool = buildEmitHealResultTool(healDeps({ getActiveControlReportId: () => 'R1' }));
    await expect(tool.handler(params('fixed', 'R2'), {} as never)).rejects.toThrow('No active repair for reportId R2');
  });

  it('rejects a report whose result was already emitted', async () => {
    const tool = buildEmitHealResultTool(healDeps({ isControlReportCompleted: () => true }));
    await expect(tool.handler(params('fixed'), {} as never)).rejects.toThrow('Repair result already emitted');
  });

  it('rejects when the control queue is unavailable', async () => {
    const tool = buildEmitHealResultTool(healDeps({ getControlQueue: () => null }));
    await expect(tool.handler(params('fixed'), {} as never)).rejects.toThrow('Control queue not found');
  });
});

describe('emit_heal_result handler effects', () => {
  it('fixed: notifies loops HEAL_COMPLETE, resolves the row, and marks completed without advancing the slot', async () => {
    const q = fakeQueue();
    const db = fakeDb();
    const mark = vi.fn();
    const tool = buildEmitHealResultTool(healDeps({
      getControlQueue: () => q.queue,
      db: db.db,
      markControlReportCompleted: mark,
    }));

    const result = await tool.handler(params('fixed'), {} as never);

    expect(q.sendControlMessage).toHaveBeenCalledTimes(1);
    const [, protocol, payload] = q.sendControlMessage.mock.calls[0]!;
    expect(protocol).toBe('HEAL_COMPLETE');
    expect((payload as { reportId: string }).reportId).toBe('R1');
    expect(db.run).toHaveBeenCalledWith('R1');
    expect(mark).toHaveBeenCalledWith('R1');
    expect(result).toEqual({ sent: true, reportId: 'R1', result: 'fixed' });
  });

  it('escalate: notifies loops HEAL_ESCALATE (admin DM skipped when no admin phones)', async () => {
    const q = fakeQueue();
    const mark = vi.fn();
    const tool = buildEmitHealResultTool(healDeps({
      getControlQueue: () => q.queue,
      adminPhones: new Set<string>(),
      markControlReportCompleted: mark,
    }));

    const result = await tool.handler(params('escalate'), {} as never);

    expect(q.sendControlMessage).toHaveBeenCalledTimes(1);
    expect(q.sendControlMessage.mock.calls[0]![1]).toBe('HEAL_ESCALATE');
    expect(mark).toHaveBeenCalledWith('R1');
    expect(result).toEqual({ sent: true, reportId: 'R1', result: 'escalate' });
  });
});

describe('registerRuntimeInlineTools gating', () => {
  function deps(overrides: Partial<RuntimeInlineToolsDeps> = {}): RuntimeInlineToolsDeps {
    return {
      sandbox: false,
      sandboxPerChat: false,
      emitHealResult: healDeps(),
      restartSelf: restartDeps(),
      ...overrides,
    };
  }

  it('registers both tools (emit_heal_result first) on a non-sandboxed instance with control peers and a restarter', () => {
    const { registry, names } = fakeRegistry();
    registerRuntimeInlineTools(registry, deps());
    expect(names).toEqual(['emit_heal_result', 'restart_self']);
  });

  it('omits emit_heal_result when no control peers are configured', () => {
    const { registry, names } = fakeRegistry();
    registerRuntimeInlineTools(registry, deps({ emitHealResult: healDeps({ controlPeers: new Map() }) }));
    expect(names).toEqual(['restart_self']);
  });

  it('omits restart_self when no service restarter is wired', () => {
    const { registry, names } = fakeRegistry();
    registerRuntimeInlineTools(registry, deps({ restartSelf: null }));
    expect(names).toEqual(['emit_heal_result']);
  });

  it('registers nothing on a sandboxed instance', () => {
    const { registry, names } = fakeRegistry();
    registerRuntimeInlineTools(registry, deps({ sandbox: true }));
    expect(names).toEqual([]);
  });

  it('registers nothing on a per-chat-sandboxed instance', () => {
    const { registry, names } = fakeRegistry();
    registerRuntimeInlineTools(registry, deps({ sandboxPerChat: true }));
    expect(names).toEqual([]);
  });
});
