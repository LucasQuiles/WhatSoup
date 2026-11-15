#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const trace = (event, value = {}) => {
  if (process.env.FAKE_M365_TRACE) {
    appendFileSync(process.env.FAKE_M365_TRACE, `${JSON.stringify({ event, ...value })}\n`);
  }
};

const respond = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = process.env.FAKE_M365_SCENARIO ?? 'success';

trace('boot', {
  argv: process.argv.slice(2),
  authorityRequired: process.env.MS365_WORKFLOW_AUTHORITY_REQUIRED,
  authoritySocket: process.env.MS365_WORKFLOW_AUTHORITY_SOCKET,
  sessionToken: process.env.WHATSOUP_MCP_SESSION_TOKEN,
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  trace('request', { method: message.method, params: message.params });

  if (message.method === 'initialize') {
    respond({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-microsoft365', version: '1.0.0' },
      },
    });
    continue;
  }

  if (message.method === 'notifications/initialized') continue;

  if (message.method === 'tools/list') {
    respond({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: process.env.FAKE_M365_CATALOG_TOOL ?? 'list-mail-messages',
          description: 'fake Microsoft 365 tool',
          inputSchema: { type: 'object' },
        }],
      },
    });
    continue;
  }

  if (message.method === 'tools/call') {
    if (scenario === 'hang') {
      const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      trace('hang', { pid: process.pid, descendantPid: child.pid });
      continue;
    }
    if (scenario === 'stderr-overflow') {
      process.stderr.write('x'.repeat(Number(process.env.FAKE_M365_OVERFLOW_BYTES ?? '4096')));
      continue;
    }
    if (scenario === 'stdout-overflow') {
      process.stdout.write('x'.repeat(Number(process.env.FAKE_M365_OVERFLOW_BYTES ?? '4096')));
      continue;
    }
    if (scenario === 'rpc-error') {
      respond({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'token=rpc-secret' } });
      continue;
    }
    if (scenario === 'tool-error') {
      respond({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'token=tool-secret' }] },
      });
      continue;
    }
    respond({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `called ${message.params.name}` }],
      },
    });
  }
}
