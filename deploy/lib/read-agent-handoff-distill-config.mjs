#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: read-agent-handoff-distill-config.mjs <instance-config>\n');
  process.exit(64);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  process.stderr.write('FATAL: could not read instance config for handoff-distill projection\n');
  process.exit(1);
}

const handoff = parsed?.agentOptions?.handoffDistill;
if (handoff === undefined) {
  process.stdout.write('legacy');
  process.exit(0);
}
if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff) || typeof handoff.enabled !== 'boolean') {
  process.stderr.write('FATAL: malformed agentOptions.handoffDistill credential projection\n');
  process.exit(1);
}
if (handoff.enabled === false) {
  process.stdout.write('disabled');
  process.exit(0);
}
if (handoff.provider === 'deepseek' && handoff.model === 'deepseek-flash') {
  process.stdout.write('deepseek-flash');
  process.exit(0);
}
process.stderr.write('FATAL: refused agentOptions.handoffDistill credential projection\n');
process.exit(1);
