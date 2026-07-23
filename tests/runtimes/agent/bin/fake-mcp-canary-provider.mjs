#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ownedRoot = dirname(process.cwd());
const expectedRoots = {
  HOME: join(ownedRoot, 'home'),
  XDG_CONFIG_HOME: join(ownedRoot, 'config'),
  XDG_DATA_HOME: join(ownedRoot, 'data'),
  TMPDIR: join(ownedRoot, 'tmp'),
};
for (const [key, expected] of Object.entries(expectedRoots)) {
  if (process.env[key] !== expected) process.exit(90);
  if (existsSync(join(process.env[key], 'forbidden-canary-config'))) process.exit(91);
}
if (process.env.CLAUDE_CONFIG_DIR !== undefined) process.exit(92);

const values = process.argv.slice(2);
const commandValue = values.find((value) =>
  value.startsWith('mcp_servers.whatsoup.command='));
const argsValue = values.find((value) =>
  value.startsWith('mcp_servers.whatsoup.args='));

let command;
let args;
if (commandValue && argsValue) {
  command = JSON.parse(commandValue.slice(commandValue.indexOf('=') + 1));
  args = JSON.parse(argsValue.slice(argsValue.indexOf('=') + 1));
} else if (existsSync(join(process.cwd(), '.mcp.json'))) {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), '.mcp.json'), 'utf8'),
  ).mcpServers.whatsoup;
  command = config.command;
  args = config.args;
} else {
  const commandLine = JSON.parse(
    readFileSync(join(process.cwd(), 'opencode.json'), 'utf8'),
  ).mcp.whatsoup.command;
  [command, ...args] = commandLine;
}
const proxy = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'ignore'],
});

let responses = 0;
proxy.stdout.setEncoding('utf8');
proxy.stdout.on('data', (chunk) => {
  responses += String(chunk).split('\n').filter(Boolean).length;
  if (responses >= 2) setInterval(() => {}, 1_000);
});
proxy.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
})}\n`);
proxy.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
})}\n`);
setInterval(() => {}, 1_000);
