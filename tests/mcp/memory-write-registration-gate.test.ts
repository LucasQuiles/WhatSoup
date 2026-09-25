// tests/mcp/memory-write-registration-gate.test.ts
// #1976 work item: pin the memory_write REGISTRATION GATE itself.
//
// registerAllTools registers memory_write only when BOTH hold:
//   1. config.pineconeIndex is set, and
//   2. process.env[config.memory?.pinecone?.apiKeyEnv ?? 'PINECONE_API_KEY'] is set.
//
// This gate is why the per-tier advertised surface is environment-dependent:
// with the gate open, a chat-scoped session sees one additional tool
// (memory_write, scope 'chat'). The test controls the gate inputs explicitly
// so it is deterministic on CI (no key) and on memory-configured dev hosts
// (key exported in the shell) alike.

import { describe, it, expect, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';
import { config } from '../../src/config.ts';

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

const DEFAULT_KEY_ENV = 'PINECONE_API_KEY';

const originalKey = process.env[DEFAULT_KEY_ENV];
const originalCustom = process.env.WHATSOUP_PROBE_CUSTOM_KEY;
const originalIndex = (config as { pineconeIndex?: string }).pineconeIndex;
const originalMemory = (config as { memory?: unknown }).memory;

function setGate(index: string | undefined, envName: string, envValue: string | undefined): void {
  (config as { pineconeIndex?: string }).pineconeIndex = index;
  if (envName === DEFAULT_KEY_ENV) {
    if (envValue === undefined) delete process.env[DEFAULT_KEY_ENV];
    else process.env[DEFAULT_KEY_ENV] = envValue;
    delete process.env.WHATSOUP_PROBE_CUSTOM_KEY;
  } else {
    delete process.env[DEFAULT_KEY_ENV];
    if (envValue === undefined) delete process.env[envName];
    else process.env[envName] = envValue;
  }
}

// One shared database for the whole file: registerAllTools only registers
// tools (no handler is invoked here), so per-case isolation comes from the
// fresh ToolRegistry, not the DB — and slow ARM runners don't pay the 60+
// migration cost five times over.
const sharedDb = new Database(':memory:');
sharedDb.open();

/** Register everything into a fresh registry and report memory_write's state. */
function registerAndInspect(): { registered: boolean; declaration?: ToolDeclaration } {
  const registry = new ToolRegistry();
  const captured: ToolDeclaration[] = [];
  const origRegister = registry.register.bind(registry);
  registry.register = (tool: ToolDeclaration) => {
    captured.push(tool);
    origRegister(tool);
  };
  registerAllTools(registry, makeConnection(), sharedDb);
  const declaration = captured.find((t) => t.name === 'memory_write');
  return { registered: declaration !== undefined, declaration };
}

afterEach(() => {
  if (originalKey === undefined) delete process.env[DEFAULT_KEY_ENV];
  else process.env[DEFAULT_KEY_ENV] = originalKey;
  if (originalCustom === undefined) delete process.env.WHATSOUP_PROBE_CUSTOM_KEY;
  else process.env.WHATSOUP_PROBE_CUSTOM_KEY = originalCustom;
  (config as { pineconeIndex?: string }).pineconeIndex = originalIndex;
  (config as { memory?: unknown }).memory = originalMemory;
});

describe('memory_write registration gate (#1976)', () => {
  it('registers memory_write when pineconeIndex and the default-key env are both set', () => {
    setGate('probe-index', DEFAULT_KEY_ENV, 'probe-dummy-not-a-secret');
    const { registered, declaration } = registerAndInspect();
    expect(registered).toBe(true);
    // The tool's own security posture, pinned where it is registered.
    expect(declaration?.scope).toBe('chat');
    expect(declaration?.targetMode).toBe('injected');
    expect(declaration?.core).toBe(false);
  });

  it('does not register when the API key env is absent (index alone is insufficient)', () => {
    setGate('probe-index', DEFAULT_KEY_ENV, undefined);
    const { registered } = registerAndInspect();
    expect(registered).toBe(false);
  });

  it('does not register when pineconeIndex is absent (key alone is insufficient)', () => {
    setGate(undefined, DEFAULT_KEY_ENV, 'probe-dummy-not-a-secret');
    const { registered } = registerAndInspect();
    expect(registered).toBe(false);
  });

  it('resolves the key through memory.pinecone.apiKeyEnv when configured', () => {
    (config as { memory?: unknown }).memory = { pinecone: { apiKeyEnv: 'WHATSOUP_PROBE_CUSTOM_KEY' } };
    setGate('probe-index', 'WHATSOUP_PROBE_CUSTOM_KEY', 'probe-dummy-not-a-secret');
    const { registered } = registerAndInspect();
    expect(registered).toBe(true);
  });

  it('ignores the default key name when a custom apiKeyEnv is configured but unset', () => {
    // PINECONE_API_KEY present but the CONFIGURED name is not: the resolver
    // must honor memory.pinecone.apiKeyEnv, not fall back to the default.
    (config as { memory?: unknown }).memory = { pinecone: { apiKeyEnv: 'WHATSOUP_PROBE_CUSTOM_KEY' } };
    setGate('probe-index', DEFAULT_KEY_ENV, 'probe-dummy-not-a-secret');
    const { registered } = registerAndInspect();
    expect(registered).toBe(false);
  });
});
