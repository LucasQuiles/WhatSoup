import { createConnection, type Socket } from 'node:net';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:mcp-client');

export interface McpCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Send a tools/call request via JSON-RPC 2.0 over Unix socket */
export async function mcpCall(
  socketPath: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<McpCallResult> {
  return new Promise((resolve) => {
    let socket: Socket;
    let settled = false;

    const settle = (result: McpCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      log.warn({ socketPath, toolName }, 'mcpCall timed out');
      settle({ success: false, error: 'timeout' });
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch (err) {
      settle({ success: false, error: `connection failed: ${(err as Error).message}` });
      return;
    }

    let buffer = '';
    let initialized = false;

    socket.on('error', (err) => {
      log.warn({ err, socketPath, toolName }, 'mcpCall socket error');
      settle({ success: false, error: err.message });
    });

    socket.on('close', () => {
      settle({ success: false, error: 'connection closed unexpectedly' });
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process newline-delimited JSON-RPC messages
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (!initialized && msg.id === 1 && msg.result?.serverInfo) {
            // Initialize response received, now send the tool call
            initialized = true;
            const callMsg = JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: toolName, arguments: args },
            });
            socket.write(callMsg + '\n');
            continue;
          }

          if (msg.id === 2) {
            // Tool call response
            if (msg.error) {
              settle({
                success: false,
                error: msg.error.message ?? JSON.stringify(msg.error),
              });
            } else {
              settle({ success: true, result: msg.result });
            }
            return;
          }
        } catch {
          // Ignore parse errors on partial lines
        }
      }
    });

    socket.on('connect', () => {
      // Send initialize request
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'fleet-client', version: '1.0.0' },
        },
      });
      socket.write(initMsg + '\n');
    });
  });
}
