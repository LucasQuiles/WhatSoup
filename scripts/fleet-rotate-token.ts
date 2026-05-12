#!/usr/bin/env node
// scripts/fleet-rotate-token.ts
//
// Rotate the active fleet token (issue #237).
//
// Reads the existing `~/.config/whatsoup/fleet-tokens.json`, generates a new
// 32-byte token, moves the prior `active` into the head of `accept[]` (capped
// at the storage layer's MAX_ACCEPT_ENTRIES), persists, and prints the new
// active token to stdout. Operators paste it into their console/API client.
//
// Behaviors:
//  - missing file              → initialize (new active, empty accept[])
//  - present legacy file only  → migrate via loadOrCreateFleetTokens, then rotate
//  - corrupt file              → refuse; do not auto-fix; nonzero exit
//
// CLI flags (kept minimal — this script is invoked by operators, not CI):
//   --dry-run    print what would change but do not write
//   --json       emit a machine-readable summary to stdout
//   --quiet      suppress the human banner before the active token
//   --help / -h  show usage

import { argv, exit, stdout, stderr } from 'node:process';
import {
  loadOrCreateFleetTokens,
  rotateFleetTokens,
  saveFleetTokens,
  getFleetTokensPath,
  type FleetTokensFile,
} from '../src/fleet/token-storage.ts';

interface CliArgs {
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  help: boolean;
}

export function parseArgs(args: readonly string[]): CliArgs {
  const out: CliArgs = { dryRun: false, json: false, quiet: false, help: false };
  for (const a of args) {
    switch (a) {
      case '--dry-run': out.dryRun = true; break;
      case '--json':    out.json = true; break;
      case '--quiet':   out.quiet = true; break;
      case '--help':
      case '-h':        out.help = true; break;
      default:
        throw Object.assign(new Error(`unknown argument: ${a}`), { code: 'EUSAGE' });
    }
  }
  return out;
}

const USAGE = `Usage: fleet-rotate-token [--dry-run] [--json] [--quiet]

Rotate the active fleet token. The prior active is preserved on the
accept[] list so in-flight clients keep working until they refresh.

Storage: ${getFleetTokensPath()}
`;

export interface RotateResult {
  before: FleetTokensFile;
  after: FleetTokensFile;
  wrote: boolean;
}

/**
 * Pure rotation step — visible for tests so they can exercise the logic
 * without spawning a subprocess.
 */
export function rotateOnce(opts: { dryRun: boolean }): RotateResult {
  const before = loadOrCreateFleetTokens();
  const after = rotateFleetTokens(before);
  if (!opts.dryRun) saveFleetTokens(after);
  return { before, after, wrote: !opts.dryRun };
}

export function main(rawArgs: readonly string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(rawArgs);
  } catch (err) {
    stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  let result: RotateResult;
  try {
    result = rotateOnce({ dryRun: args.dryRun });
  } catch (err) {
    stderr.write(`fleet-rotate-token: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.json) {
    stdout.write(`${JSON.stringify({
      path: getFleetTokensPath(),
      activeToken: result.after.active,
      acceptSize: result.after.accept.length,
      rotatedAt: result.after.rotatedAt,
      dryRun: !result.wrote,
    })}\n`);
    return 0;
  }

  if (!args.quiet) {
    const banner = result.wrote
      ? 'Rotated fleet token. Update your console / API clients with the new value:'
      : 'DRY RUN — no file written. Proposed new active token:';
    stdout.write(`${banner}\n`);
  }
  stdout.write(`${result.after.active}\n`);
  return 0;
}

// Run only when invoked as a script (not when imported by the test file).
const invokedDirectly = (() => {
  try {
    return import.meta.url === new URL(`file://${argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = main(argv.slice(2));
  exit(code);
}
