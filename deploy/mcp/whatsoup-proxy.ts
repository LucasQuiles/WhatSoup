#!/usr/bin/env node
/**
 * whatsoup-proxy.ts — stdio-to-Unix-socket relay for Claude Code MCP integration.
 *
 * Prefers the actor-bound WHATSOUP_MCP_SOCKET, then falls back to the static
 * WHATSOUP_SOCKET for compatibility outside eligible per-chat sessions.
 */

import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const socketPath =
  process.env['WHATSOUP_MCP_SOCKET']?.trim()
  || process.env['WHATSOUP_SOCKET']?.trim();

const unavailable = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32603, message: 'MCP transport unavailable' },
};

if (!socketPath) {
  process.stdout.write(JSON.stringify(unavailable) + '\n');
  process.exit(1);
}

const socket = createConnection(socketPath);
// QR-053: UTF-8-decode so a multibyte char split across a read boundary is not
// silently corrupted to U+FFFD before the line-delimited JSON-RPC is parsed.
socket.setEncoding('utf8');

socket.on('error', () => {
  process.stdout.write(JSON.stringify(unavailable) + '\n');
  process.exit(1);
});

// Relay socket responses → stdout
let socketBuf = '';
socket.on('data', (chunk: string) => {
  socketBuf += chunk.toString();
  const lines = socketBuf.split('\n');
  socketBuf = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) {
      process.stdout.write(line + '\n');
    }
  }
});

socket.on('close', () => {
  process.exit(0);
});

// Relay stdin lines → socket
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed) {
    socket.write(trimmed + '\n');
  }
});

rl.on('close', () => {
  socket.end();
});
