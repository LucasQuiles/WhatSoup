/**
 * Tests for SP5: relay_message guardrails in src/mcp/tools/advanced.ts.
 *
 * The relay_message MCP tool has two guardrails:
 *   1. Config gate: throws when config.advanced.enableRelayMessage is false (default)
 *   2. Payload size cap: throws when JSON.stringify(proto).length > relayMaxPayloadBytes
 *
 * These tests use the ToolRegistry + registerAdvancedTools pattern consistent
 * with the rest of the advanced tool tests. The config module is mocked so
 * we can set enableRelayMessage and relayMaxPayloadBytes at will.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerAdvancedTools } from '../../../src/mcp/tools/advanced.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Config mock — start with relay disabled (the production default)
// ---------------------------------------------------------------------------

vi.mock('../../../src/config.ts', () => ({
  config: {
    advanced: {
      enableRelayMessage: false,
      enableResync: false,
      relayMaxPayloadBytes: 1_048_576, // 1 MB
    },
    controlPeers: new Map<string, string>(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function makeMockSock(): WhatsAppSocket {
  return {
    relayMessage: vi.fn().mockResolvedValue({ messageId: 'relayed-msg-id' }),
    resyncAppState: vi.fn().mockResolvedValue(undefined),
    createCallLink: vi.fn().mockResolvedValue({ link: 'https://call.whatsapp.com/test' }),
    sendMessage: vi.fn().mockResolvedValue({ status: 'sent' }),
    requestPairingCode: vi.fn().mockResolvedValue('TEST-CODE'),
    getBotListV2: vi.fn().mockResolvedValue([]),
    logout: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

function makeRegistry(sock: WhatsAppSocket | null): ToolRegistry {
  const registry = new ToolRegistry();
  registerAdvancedTools(() => sock, (tool) => registry.register(tool));
  return registry;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// SP5-01: Config gate — throws when enableRelayMessage is false
// ===========================================================================

describe('SP5-01: config gate — relay_message disabled by default', () => {
  it('returns an error when enableRelayMessage is false', async () => {
    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    // Config mock has enableRelayMessage: false (the default production value)
    const result = await registry.call(
      'relay_message',
      { jid: '15551234567@s.whatsapp.net', proto: { conversation: 'test' } },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/i);
  });

  it('does NOT call sock.relayMessage when the feature gate is closed', async () => {
    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    await registry.call(
      'relay_message',
      { jid: '15551234567@s.whatsapp.net', proto: { data: 'payload' } },
      globalSession(),
    );

    expect(vi.mocked(sock.relayMessage)).not.toHaveBeenCalled();
  });

  it('error message mentions the config key to enable it', async () => {
    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    const result = await registry.call(
      'relay_message',
      { jid: '15551234567@s.whatsapp.net', proto: {} },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/enableRelayMessage/);
  });

  it('is rejected even when the payload is small and JID is valid', async () => {
    // Guards should be checked in order; the config gate is first
    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    const tinyProto = { x: 1 };
    const result = await registry.call(
      'relay_message',
      { jid: '111@s.whatsapp.net', proto: tinyProto },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/i);
    expect(vi.mocked(sock.relayMessage)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// SP5-02: Payload size cap — throws when payload exceeds relayMaxPayloadBytes
// ===========================================================================

describe('SP5-02: payload size cap', () => {
  it('returns an error when the serialised proto exceeds relayMaxPayloadBytes', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    const originalMax = config.advanced.relayMaxPayloadBytes;

    // Enable relay and set a very small cap
    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;
    (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = 50;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      // Build a proto that serialises to more than 50 bytes
      const bigProto = { data: 'x'.repeat(100) }; // well over 50 bytes when JSON-stringified
      const result = await registry.call(
        'relay_message',
        { jid: '15551234567@s.whatsapp.net', proto: bigProto },
        globalSession(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/too large/i);
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = originalMax;
    }
  });

  it('error message reports the actual payload size and the configured max', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    const originalMax = config.advanced.relayMaxPayloadBytes;

    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;
    (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = 10;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const result = await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto: { key: 'value_that_is_longer_than_ten_bytes' } },
        globalSession(),
      );

      expect(result.isError).toBe(true);
      // Error should mention bytes
      expect(result.content[0].text).toMatch(/bytes/i);
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = originalMax;
    }
  });

  it('does NOT call sock.relayMessage when payload exceeds the cap', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    const originalMax = config.advanced.relayMaxPayloadBytes;

    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;
    (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = 5;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto: { msg: 'definitely more than 5 bytes' } },
        globalSession(),
      );

      expect(vi.mocked(sock.relayMessage)).not.toHaveBeenCalled();
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = originalMax;
    }
  });

  it('payload at exactly the limit is accepted', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    const originalMax = config.advanced.relayMaxPayloadBytes;

    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      // Build a proto whose JSON is exactly N bytes, then set limit to N
      const proto = { k: 'v' }; // {"k":"v"} = 9 bytes
      const size = JSON.stringify(proto).length;
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = size;

      const result = await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto },
        globalSession(),
      );

      // Should succeed (size === limit, not strictly greater than)
      expect(result.isError).toBeUndefined();
      expect(vi.mocked(sock.relayMessage)).toHaveBeenCalledOnce();
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = originalMax;
    }
  });
});

// ===========================================================================
// SP5-03: Success path — enabled + payload within limits
// ===========================================================================

describe('SP5-03: success path — enabled and within payload limit', () => {
  it('calls sock.relayMessage when enabled and payload is within limit', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;

    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const proto = { conversation: 'hello' };
      const result = await registry.call(
        'relay_message',
        { jid: '15551234567@s.whatsapp.net', proto },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(vi.mocked(sock.relayMessage)).toHaveBeenCalledOnce();
      expect(vi.mocked(sock.relayMessage)).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        proto,
        {},
      );
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
    }
  });

  it('returns relayed: true with the correct jid', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const result = await registry.call(
        'relay_message',
        { jid: '15551234567@s.whatsapp.net', proto: { text: 'hi' } },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { relayed: boolean; jid: string };
      expect(data.relayed).toBe(true);
      expect(data.jid).toBe('15551234567@s.whatsapp.net');
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
    }
  });

  it('passes optional opts through to sock.relayMessage', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const opts = { messageId: 'custom-id-123', participant: 'part@s.whatsapp.net' };
      await registry.call(
        'relay_message',
        { jid: '15551234567@s.whatsapp.net', proto: { x: 1 }, opts },
        globalSession(),
      );

      expect(vi.mocked(sock.relayMessage)).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        { x: 1 },
        opts,
      );
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
    }
  });

  it('accepts @g.us JID when enabled', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const result = await registry.call(
        'relay_message',
        { jid: '111111100000000001@g.us', proto: { msg: 'group relay' } },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(vi.mocked(sock.relayMessage)).toHaveBeenCalledWith(
        '111111100000000001@g.us',
        { msg: 'group relay' },
        {},
      );
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
    }
  });

  it('accepts @lid JID when enabled', async () => {
    const { config } = await import('../../../src/config.ts');
    const originalEnabled = config.advanced.enableRelayMessage;
    (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = true;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const result = await registry.call(
        'relay_message',
        { jid: '12345@lid', proto: { data: 'lid relay' } },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
    } finally {
      (config.advanced as { enableRelayMessage: boolean }).enableRelayMessage = originalEnabled;
    }
  });
});

// ===========================================================================
// SP5-04: Guardrail interaction — disabled gate takes precedence over size cap
// ===========================================================================

describe('SP5-04: guardrail ordering', () => {
  it('config gate error is returned even when payload also exceeds the size cap', async () => {
    // enableRelayMessage=false (from mock), relayMaxPayloadBytes=1 (impossibly small)
    const { config } = await import('../../../src/config.ts');
    const originalMax = config.advanced.relayMaxPayloadBytes;
    (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = 1;

    const sock = makeMockSock();
    const registry = makeRegistry(sock);

    try {
      const result = await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto: { enormous: 'payload'.repeat(100) } },
        globalSession(),
      );

      // Config gate fires first
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/disabled/i);
    } finally {
      (config.advanced as { relayMaxPayloadBytes: number }).relayMaxPayloadBytes = originalMax;
    }
  });
});
