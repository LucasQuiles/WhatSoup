import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassiveRuntime } from '../../../src/runtimes/passive/runtime.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';

describe('PassiveRuntime', () => {
  // Create mock objects matching the interfaces PassiveRuntime needs
  const mockConnection = {
    getSocket: () => ({}),
    presenceCache: new Map(),
  };
  const mockRawDb = {
    prepare: () => ({
      run: vi.fn(),
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
    }),
  };
  const mockDb = { raw: mockRawDb };
  const mockConfig = {
    name: 'test-passive',
    paths: { stateRoot: '/tmp/whatsoup-passive-test' },
  };

  it('implements Runtime interface methods', () => {
    const runtime = new PassiveRuntime(mockDb as any, mockConnection as any, mockConfig);
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.handleMessage).toBe('function');
    expect(typeof runtime.getHealthSnapshot).toBe('function');
    expect(typeof runtime.shutdown).toBe('function');
    expect(typeof runtime.setDurability).toBe('function');
  });

  it('getHealthSnapshot returns healthy synchronously', () => {
    const runtime = new PassiveRuntime(mockDb as any, mockConnection as any, mockConfig);
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.status).toBe('healthy');
  });

  it('handleMessage is a no-op without durability', async () => {
    const runtime = new PassiveRuntime(mockDb as any, mockConnection as any, mockConfig);
    await expect(runtime.handleMessage({ messageId: 'test' } as any)).resolves.toBeUndefined();
  });

  it('handleMessage completes inbound lifecycle when durability is set', async () => {
    const runtime = new PassiveRuntime(mockDb as any, mockConnection as any, mockConfig);
    const mockDurability = {
      completeInbound: vi.fn(),
      setDurability: vi.fn(),
    } as unknown as DurabilityEngine;
    runtime.setDurability(mockDurability);

    await runtime.handleMessage({ messageId: 'test', inboundSeq: 42 } as any);
    expect(mockDurability.completeInbound).toHaveBeenCalledWith(42, 'passive_instance');
  });

  it('handleMessage skips durability when inboundSeq is undefined', async () => {
    const runtime = new PassiveRuntime(mockDb as any, mockConnection as any, mockConfig);
    const mockDurability = {
      completeInbound: vi.fn(),
      setDurability: vi.fn(),
    } as unknown as DurabilityEngine;
    runtime.setDurability(mockDurability);

    await runtime.handleMessage({ messageId: 'test', inboundSeq: undefined } as any);
    expect(mockDurability.completeInbound).not.toHaveBeenCalled();
  });
});
