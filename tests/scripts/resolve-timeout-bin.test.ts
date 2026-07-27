import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'resolve-timeout-bin.sh');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'quality.yml');

function writeExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

function runResolver(path: string) {
  return spawnSync('/bin/bash', ['-e', SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: path },
  });
}

describe('resolve-timeout-bin', () => {
  it('prints a diagnostic and fails under bash -e when neither binary exists', () => {
    const bin = mkdtempSync(join(tmpdir(), 'whatsoup-timeout-missing-'));
    try {
      const result = runResolver(bin);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Neither timeout nor gtimeout found. On macOS: brew install coreutils',
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('prefers gtimeout when both supported binaries exist', () => {
    const bin = mkdtempSync(join(tmpdir(), 'whatsoup-timeout-both-'));
    try {
      const gtimeout = writeExecutable(bin, 'gtimeout');
      writeExecutable(bin, 'timeout');

      const result = runResolver(bin);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(gtimeout);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('selects timeout when gtimeout is unavailable', () => {
    const bin = mkdtempSync(join(tmpdir(), 'whatsoup-timeout-linux-'));
    try {
      const timeout = writeExecutable(bin, 'timeout');

      const result = runResolver(bin);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(timeout);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('keeps the tested resolver wired into the hosted quality workflow', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');

    expect(workflow).toContain('TIMEOUT_BIN="$(bash scripts/resolve-timeout-bin.sh)"');
    expect(workflow).toContain('if "$TIMEOUT_BIN" 300 npx playwright install chromium; then');
  });
});
