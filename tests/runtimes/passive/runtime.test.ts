import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassiveRuntime } from '../../../src/runtimes/passive/runtime.ts';
import { Database } from '../../../src/core/database.ts';
import { PresenceCache } from '../../../src/transport/presence-cache.ts';
import type { ConnectionManager } from '../../../src/transport/connection.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map() },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

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

  describe('start() and shutdown()', () => {
    let tmpDir: string;
    let db: Database;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'whatsoup-passive-'));
      db = new Database(':memory:');
      db.open();
    });

    afterEach(() => {
      db.raw.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('registers tools and creates socket server on start', async () => {
      const connection = makeConnection();
      const config = { name: 'test-passive', paths: { stateRoot: tmpDir } };
      const runtime = new PassiveRuntime(db, connection, config);

      await runtime.start();

      // Socket file should exist after start
      const { existsSync } = await import('node:fs');
      const socketPath = join(tmpDir, 'whatsoup.sock');
      expect(existsSync(socketPath)).toBe(true);

      await runtime.shutdown();
      // Socket cleaned up after shutdown
      expect(existsSync(socketPath)).toBe(false);
    });
  });
});
