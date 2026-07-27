import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { unlinkSync } from 'node:fs';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockLog,
}));

import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import type { ToolRegistry } from '../../src/mcp/registry.ts';
import { makeSocketPath } from '../helpers/socket-rpc.ts';
import { waitForSocket } from '../helpers/wait-for.ts';

function sendRawLine(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(`${line}\n`);
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      for (const responseLine of buffer.split('\n')) {
        if (!responseLine.trim()) continue;
        try {
          resolve(JSON.parse(responseLine));
          client.end();
        } catch {
          // Wait for the rest of an incomplete response frame.
        }
      }
    });
    client.on('error', reject);
  });
}

describe('WhatSoupSocketServer malformed JSON-RPC logging', () => {
  let socketPath: string;
  let server: WhatSoupSocketServer;

  beforeEach(() => {
    socketPath = makeSocketPath();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
  });

  afterEach(() => {
    server?.stop();
    try {
      unlinkSync(socketPath);
    } catch {
      // The server normally removes its owned socket.
    }
  });

  it('retains bounded structural diagnostics without logging malformed payload content', async () => {
    server = new WhatSoupSocketServer(
      socketPath,
      {} as ToolRegistry,
      { tier: 'global' },
    );
    server.start();
    await waitForSocket(socketPath);

    const privateText = 'MAGENTA-PRIVATE-MESSAGE-71f845';
    const secretToken = ['sk', 'test', 'secret', 'redaction', 'fixture'].join('-');
    const malformed = [
      '{"jsonrpc":"2.0","id":91,"method":"tools/call","params":',
      `{"name":"send_message","arguments":{"text":"${privateText}",`,
      `"apiKey":"${secretToken}"}}`,
    ].join('');

    const response = await sendRawLine(socketPath, malformed);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      {
        clientId: 1,
        category: 'invalid_json',
        frameLength: malformed.length,
      },
      'failed to parse JSON-RPC message',
    );

    const capturedEvents = JSON.stringify({
      info: mockLog.info.mock.calls,
      warn: mockLog.warn.mock.calls,
      error: mockLog.error.mock.calls,
      debug: mockLog.debug.mock.calls,
    });
    expect(capturedEvents).not.toContain(malformed);
    expect(capturedEvents).not.toContain(privateText);
    expect(capturedEvents).not.toContain(secretToken);
    expect(capturedEvents).not.toContain('send_message');
    expect(capturedEvents).not.toContain('apiKey');
    expect(capturedEvents).not.toContain('arguments');
  });
});
