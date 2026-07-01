import { afterEach, describe, expect, it, vi } from 'vitest';

describe('mcpCall edge paths', () => {
  afterEach(() => {
    vi.doUnmock('node:net');
    vi.resetModules();
  });

  it('returns a connection failure when the Unix socket cannot be constructed', async () => {
    vi.doMock('node:net', async (importOriginal: () => Promise<typeof import('node:net')>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createConnection: vi.fn(() => {
          throw new Error('bad socket path');
        }),
      };
    });
    const { mcpCall } = await import('../../src/fleet/mcp-client.ts');

    await expect(mcpCall('/tmp/whatsoup.sock', 'status', {}, 50)).resolves.toEqual({
      success: false,
      error: 'connection failed: bad socket path',
    });
  });
});
