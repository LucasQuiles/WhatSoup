#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import {
  ControlManifestError,
  buildControlInventory,
  digestControlManifest,
  loadControlManifest,
} from './lib/ci-control/manifest.ts';

type ManifestCommand = 'validate' | 'inventory';

export interface ManifestCliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = 'Usage: npm run ci:manifest -- <validate|inventory> [--json]\n';

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function failure(code: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    outcome: 'inconclusive',
    exitCode: 2,
    code,
    why: 'The control manifest could not produce trusted inventory evidence.',
    guidance: ['Repair the named manifest or invocation contract.', 'Re-run the canonical validation command.'],
    reproduce: 'npm run ci:manifest -- validate --json',
    retryable: false,
  };
}

function emitFailure(code: string, json: boolean, output: ManifestCliOutput): 2 {
  if (json) output.stdout(jsonLine(failure(code)));
  else output.stderr(`INCONCLUSIVE ${code}\nFix: npm run ci:manifest -- validate --json\n`);
  return 2;
}

function parseArguments(args: readonly string[]):
  | { help: true }
  | { help: false; command: ManifestCommand; json: boolean }
  | { error: string; json: boolean } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const jsonCount = args.filter((arg) => arg === '--json').length;
  const json = jsonCount > 0;
  if (jsonCount > 1) return { error: 'ci.input.duplicate-option', json };
  const command = args[0];
  if (command !== 'validate' && command !== 'inventory') return { error: 'ci.input.command-invalid', json };
  if (args.slice(1).some((arg) => arg !== '--json')) return { error: 'ci.input.option-unknown', json };
  return { help: false, command, json };
}

export function runManifestCli(args: readonly string[], cwd: string, output: ManifestCliOutput): 0 | 2 {
  const parsed = parseArguments(args);
  if ('error' in parsed) return emitFailure(parsed.error, parsed.json, output);
  if (parsed.help) {
    output.stdout(USAGE);
    return 0;
  }
  try {
    const manifest = loadControlManifest(cwd);
    if (parsed.command === 'inventory') {
      const inventory = buildControlInventory(manifest);
      if (parsed.json) output.stdout(jsonLine(inventory));
      else output.stdout(`PASS ci.manifest.inventory\nControls: ${inventory.controls.length}\nDigest: ${inventory.manifestDigest}\n`);
      return 0;
    }
    const result = {
      schemaVersion: 1,
      outcome: 'pass',
      exitCode: 0,
      code: 'ci.manifest.valid',
      manifestDigest: digestControlManifest(manifest),
    };
    if (parsed.json) output.stdout(jsonLine(result));
    else output.stdout(`PASS ${result.code}\nDigest: ${result.manifestDigest}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ControlManifestError ? error.issue.code : 'ci.manifest.unavailable';
    return emitFailure(code, parsed.json, output);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runManifestCli(process.argv.slice(2), process.cwd(), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
