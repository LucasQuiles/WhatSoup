#!/usr/bin/env node

const { appendFileSync } = require('node:fs');
const { createConnection } = require('node:net');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

const durableMailStateDir = process.env.MS365_DURABLE_MAIL_STATE_DIR;
const trace = (event, value = {}) => {
  if (durableMailStateDir) {
    appendFileSync(join(durableMailStateDir, 'm365-fixture-trace.jsonl'), `${JSON.stringify({ event, ...value })}\n`);
  }
};
const respond = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const writeActions = new Set(['send-mail', 'create-event', 'update-event', 'delete-event']);

function authorize(toolName, params) {
  return new Promise((resolve) => {
    const socketPath = process.env.MS365_WORKFLOW_AUTHORITY_SOCKET;
    const token = process.env.WHATSOUP_MCP_SESSION_TOKEN;
    const accountId = process.env.MS365_AGENT365_ACCOUNT_ID;
    if (!socketPath || !token || !accountId) return resolve(false);
    let buffer = '';
    let done = false;
    const socket = createConnection(socketPath);
    const finish = (allowed) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(allowed);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatsoup/session', params: { token } })}\n`);
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture-m365-plugin', version: '0.2.2' } },
      })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim() || done) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
            socket.write(`${JSON.stringify({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: { name: 'authorize_m365_action', arguments: { version: 1, toolName, params, accountId, requestId: randomUUID() } },
            })}\n`);
          }
          if (message.id === 2) {
            const text = message.result?.content?.find((content) => typeof content.text === 'string')?.text;
            const result = typeof text === 'string' ? JSON.parse(text) : undefined;
            clearTimeout(timer);
            trace('workflow_authority', { allowed: result?.allowed === true });
            finish(result?.allowed === true);
          }
        } catch {
          clearTimeout(timer);
          finish(false);
        }
      }
    });
    socket.once('error', () => { clearTimeout(timer); finish(false); });
    socket.once('end', () => { clearTimeout(timer); finish(false); });
  });
}

trace('boot', {
  authorityRequired: process.env.MS365_WORKFLOW_AUTHORITY_REQUIRED,
  authoritySocket: process.env.MS365_WORKFLOW_AUTHORITY_SOCKET,
  accountId: process.env.MS365_AGENT365_ACCOUNT_ID,
  home: process.env.HOME,
  user: process.env.USER,
  logname: process.env.LOGNAME,
  pathPresent: Boolean(process.env.PATH),
  tmpdir: process.env.TMPDIR,
  lang: process.env.LANG,
  durableMailStateDir,
  unrelatedSecretPresent: Boolean(process.env.UNRELATED_M365_FIXTURE_SECRET),
});

(async () => {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line);
    trace('request', { method: message.method, params: message.params });
    if (message.method === 'initialize') {
      respond({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture-m365-guarded', version: '0.2.2' } } });
      continue;
    }
    if (message.method === 'notifications/initialized') continue;
    if (message.method === 'tools/list') {
      respond({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'list-mail-messages', description: 'fixture read', inputSchema: { type: 'object' } }] } });
      continue;
    }
    if (message.method === 'tools/call') {
      const toolName = message.params.name;
      const params = message.params.arguments ?? {};
      if (writeActions.has(toolName) && process.env.MS365_WORKFLOW_AUTHORITY_REQUIRED === '1' && !await authorize(toolName, params)) {
        respond({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'workflow authority denied' }] } });
        continue;
      }
      if (writeActions.has(toolName)) trace('write_dispatched', { toolName });
      respond({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `called ${toolName}` }] } });
    }
  }
})();
