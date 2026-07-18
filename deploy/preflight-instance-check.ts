// WhatSoup — restart-safety instance-configuration probe (#1862).
//
// Complements preflight-probe.ts (which proves the on-disk IMPORT GRAPH links)
// by proving the NAMED INSTANCE's on-disk CONFIGURATION is semantically valid —
// so a restart cannot be reported "safe to start" for an instance that does not
// exist or whose configuration runtime startup would reject (e.g. an agent cwd
// that resolves to the user home directory). Without this, a semantic config
// error is only discovered AFTER the service mutation begins.
//
// Side-effect free: it reads and validates configuration only. It opens no
// transports, binds no ports, starts no providers, and mutates no database or
// state — it runs the same shared validator (validateInstanceConfig) that config
// load and API writes use, so all four paths fail closed on the same invariants.
//
// Invoked by deploy/preflight-check.sh as:
//   <pinned-node> --experimental-strip-types preflight-instance-check.ts <instance-name>
//
// Exit codes (consumed by preflight-check.sh):
//   0  VALID   — instance exists and its config passes semantic validation
//   3  INVALID — missing instance, unreadable/unparseable config, or a config
//                runtime startup would reject (fail closed before a restart)
//   1  USAGE   — no instance-name argument

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configRoot } from '../src/fleet/paths.ts';
import { validateInstanceConfig } from '../src/core/agent-config-validator.ts';

const name = process.argv[2];
if (!name) {
  console.error('PREFLIGHT-INSTANCE: ERROR no instance-name argument');
  process.exit(1);
}

const instanceFile = join(configRoot(), name, 'config.json');

let raw: string;
try {
  raw = readFileSync(instanceFile, 'utf8');
} catch {
  console.error(
    `PREFLIGHT-INSTANCE: INVALID — instance "${name}" not found (no readable config at ${instanceFile})`,
  );
  process.exit(3);
}

let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(raw) as Record<string, unknown>;
} catch (e) {
  console.error(
    `PREFLIGHT-INSTANCE: INVALID — config.json for "${name}" is not valid JSON: ${(e as Error).message}`,
  );
  process.exit(3);
}

const error = validateInstanceConfig(parsed, { name, mode: 'load' });
if (error) {
  console.error(`PREFLIGHT-INSTANCE: INVALID — config for "${name}" rejected at ${error.field}: ${error.message}`);
  process.exit(3);
}

console.error(`PREFLIGHT-INSTANCE: VALID — instance "${name}" configuration is loadable and semantically valid`);
process.exit(0);
