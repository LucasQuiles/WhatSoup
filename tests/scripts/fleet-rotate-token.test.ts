// tests/scripts/fleet-rotate-token.test.ts
//
// Cover the rotation CLI in `scripts/fleet-rotate-token.ts`. We exercise
// `main()` and `rotateOnce()` directly rather than spawning a subprocess —
// the script is plain TypeScript and we want the failure surface to live
// inside vitest, not in shell.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  main,
  parseArgs,
  rotateOnce,
} from '../../scripts/fleet-rotate-token.ts';
import {
  getFleetTokensPath,
  loadOrCreateFleetTokens,
  type FleetTokensFile,
} from '../../src/fleet/token-storage.ts';

let tmpRoot: string;
let savedXdg: string | undefined;
let writeCaptured: string[];
let savedWrite: typeof process.stdout.write;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-rotate-cli-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
  writeCaptured = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    writeCaptured.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = savedWrite;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults to non-dry-run', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, json: false, quiet: false, help: false });
  });

  it('recognizes --dry-run, --json, --quiet, --help', () => {
    expect(parseArgs(['--dry-run', '--json', '--quiet'])).toEqual({
      dryRun: true, json: true, quiet: true, help: false,
    });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
  });

  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument: --nope/);
  });
});

describe('rotateOnce', () => {
  it('writes a new active and moves the prior into accept[0]', () => {
    const initial = loadOrCreateFleetTokens();
    const { before, after, wrote } = rotateOnce({ dryRun: false });
    expect(wrote).toBe(true);
    expect(before.active).toBe(initial.active);
    expect(after.active).not.toBe(initial.active);
    expect(after.accept[0]).toBe(initial.active);
    // File on disk reflects the new active
    const onDisk = JSON.parse(fs.readFileSync(getFleetTokensPath(), 'utf-8')) as FleetTokensFile;
    expect(onDisk.active).toBe(after.active);
  });

  it('dry-run does not write to disk', () => {
    const initial = loadOrCreateFleetTokens();
    const { after, wrote } = rotateOnce({ dryRun: true });
    expect(wrote).toBe(false);
    expect(after.active).not.toBe(initial.active);
    const onDisk = JSON.parse(fs.readFileSync(getFleetTokensPath(), 'utf-8')) as FleetTokensFile;
    expect(onDisk.active).toBe(initial.active);
  });
});

describe('main — stdout / exit codes', () => {
  it('prints the new active token (banner + token) and exits 0', () => {
    const code = main([]);
    expect(code).toBe(0);
    const stdoutText = writeCaptured.join('');
    // Banner + a 64-hex token on its own line
    expect(stdoutText).toMatch(/Rotated fleet token/);
    const tokenMatch = stdoutText.match(/[0-9a-f]{64}/);
    expect(tokenMatch).not.toBeNull();
    // The same token must be on disk
    const onDisk = JSON.parse(fs.readFileSync(getFleetTokensPath(), 'utf-8')) as FleetTokensFile;
    expect(onDisk.active).toBe(tokenMatch![0]);
  });

  it('emits machine-readable JSON when --json is passed', () => {
    const code = main(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(writeCaptured.join('').trim()) as Record<string, unknown>;
    expect(parsed.dryRun).toBe(false);
    expect(typeof parsed.activeToken).toBe('string');
    expect((parsed.activeToken as string)).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.path).toBe(getFleetTokensPath());
  });

  it('migrates a legacy single-string token, then rotates', () => {
    // Pre-stage a legacy file (no JSON yet)
    const legacyPath = path.join(tmpRoot, 'whatsoup', 'fleet-token');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const legacyToken = 'a'.repeat(64);
    fs.writeFileSync(legacyPath, legacyToken);

    const code = main([]);
    expect(code).toBe(0);

    const onDisk = JSON.parse(fs.readFileSync(getFleetTokensPath(), 'utf-8')) as FleetTokensFile;
    // Rotated → new active, legacy lives in accept[0]
    expect(onDisk.active).not.toBe(legacyToken);
    expect(onDisk.accept[0]).toBe(legacyToken);
  });

  it('refuses to run against a corrupt JSON file', () => {
    fs.mkdirSync(path.join(tmpRoot, 'whatsoup'), { recursive: true });
    fs.writeFileSync(getFleetTokensPath(), 'not-json');
    let stderrText = '';
    const savedErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrText += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = main([]);
      expect(code).toBe(1);
      expect(stderrText).toMatch(/refusing to auto-fix/);
    } finally {
      process.stderr.write = savedErr;
    }
  });
});
