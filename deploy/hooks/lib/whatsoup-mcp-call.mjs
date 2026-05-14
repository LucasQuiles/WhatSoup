import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';

const DEFAULT_TIMEOUT_MS = 5_000;
let nextId = 1;

function jsonRpcErrorMessage(error) {
  if (!error) return 'unknown JSON-RPC error';
  if (typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function callTool({ socketPath, name, args, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ ok: false, error: 'no socketPath provided' });
      return;
    }
    if (!existsSync(socketPath)) {
      resolve({ ok: false, error: `socket missing: ${socketPath}` });
      return;
    }

    const initId = nextId++;
    const callId = nextId++;
    let socket;
    let buffer = '';
    let settled = false;
    let initialized = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch (err) {
      settle({ ok: false, error: `connection failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const writeToolCall = () => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name, arguments: args ?? {} },
      })}\n`);
    };

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'whatsoup-reliability-hook', version: '1.0.0' },
        },
      })}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          settle({ ok: false, error: 'malformed JSON-RPC response' });
          return;
        }

        if (!initialized && msg.id === initId) {
          if (msg.error) {
            settle({ ok: false, error: `initialize failed: ${jsonRpcErrorMessage(msg.error)}` });
            return;
          }
          initialized = true;
          writeToolCall();
          continue;
        }

        if (msg.id === callId) {
          if (msg.error) {
            settle({ ok: false, error: `rpc error: ${jsonRpcErrorMessage(msg.error)}` });
            return;
          }
          const result = msg.result;
          settle({ ok: true, result, toolError: result?.isError === true });
          return;
        }
      }
    });

    socket.on('error', (err) => {
      settle({ ok: false, error: `socket error: ${err.message}` });
    });

    socket.on('close', () => {
      settle({ ok: false, error: 'socket closed before response' });
    });
  });
}
