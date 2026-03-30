#!/usr/bin/env node
/**
 * whatsoup-proxy.ts — stdio-to-Unix-socket relay for Claude Code MCP integration.
 *
 * Reads WHATSOUP_SOCKET from env, connects to that Unix socket, and relays
 * JSON-RPC lines between stdin/stdout and the socket. Pure transport — no MCP
 * awareness or tool knowledge.
 */

import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const socketPath = process.env['WHATSOUP_SOCKET'];

if (!socketPath) {
  const err = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32603, message: 'WHATSOUP_SOCKET env var is not set' },
  };
  process.stdout.write(JSON.stringify(err) + '\n');
  process.exit(1);
}

const socket = createConnection(socketPath);

socket.on('error', (err: NodeJS.ErrnoException) => {
  const response = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32603, message: `Socket connection error: ${err.message}` },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
  process.exit(1);
});

// Relay socket responses → stdout
let socketBuf = '';
socket.on('data', (chunk: Buffer) => {
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
