#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { readPrivateFileSync } from '../../src/lib/private-fs.ts';
import { isValidInstanceName } from '../../src/fleet/instance-name.ts';
import { validateHandoffDistillConfig } from '../../src/lib/handoff-distill-config.ts';

const [configPath, instance, mode] = process.argv.slice(2);
if (!configPath || !instance || !isValidInstanceName(instance)) {
  process.stderr.write('usage: read-agent-handoff-distill-config.mjs <instance-config> <instance-name> [--type]\n');
  process.exit(64);
}

let parsed;
try {
  const path = resolve(configPath);
  const observed = readPrivateFileSync(path, {
    label: 'instance config', maxBytes: 1024 * 1024,
    observation: { root: dirname(path) },
  });
  if (observed === null) throw new Error('missing config');
  parsed = JSON.parse(observed.bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.name !== instance || typeof parsed.type !== 'string') {
    throw new Error('instance envelope mismatch');
  }
} catch {
  process.stderr.write('FATAL: could not read instance config for handoff-distill projection\n');
  process.exit(1);
}

if (mode === '--type') {
  process.stdout.write(parsed.type);
  process.exit(0);
}
if (parsed.type !== 'agent') {
  process.stderr.write('FATAL: handoff-distill projection requires an agent instance\n');
  process.exit(1);
}

const handoff = parsed?.agentOptions?.handoffDistill;
if (handoff === undefined) {
  process.stdout.write('legacy');
  process.exit(0);
}
if (validateHandoffDistillConfig(handoff) !== null) {
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
