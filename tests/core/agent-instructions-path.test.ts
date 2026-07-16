import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateAgentInstructionsPath } from '../../src/core/agent-instructions-path.ts';

const roots: string[] = [];

function fixture(): { root: string; home: string; cwd: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-instructions-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'workspace');
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('validateAgentInstructionsPath', () => {
  it('accepts a readable regular file resolved relative to the effective cwd', () => {
    const { home, cwd } = fixture();
    const filePath = path.join(home, 'runtime.md');
    writeFileSync(filePath, 'instructions', { mode: 0o600 });

    expect(
      validateAgentInstructionsPath({
        instructionsPath: '../runtime.md',
        cwd,
        homeDirectory: home,
      }),
    ).toEqual({ ok: true, resolvedPath: filePath });
  });

  it('accepts an absolute readable file within the service-user home', () => {
    const { home, cwd } = fixture();
    const filePath = path.join(home, 'runtime.md');
    writeFileSync(filePath, 'instructions', { mode: 0o600 });

    expect(
      validateAgentInstructionsPath({ instructionsPath: filePath, cwd, homeDirectory: home }),
    ).toEqual({ ok: true, resolvedPath: filePath });
  });

  it.each([
    ['missing', 'missing'],
    ['directory', 'not_regular_file'],
  ] as const)('rejects a %s target', (_label, reason) => {
    const { home, cwd } = fixture();
    const target = path.join(cwd, 'target');
    if (reason === 'not_regular_file') mkdirSync(target);

    expect(
      validateAgentInstructionsPath({
        instructionsPath: 'target',
        cwd,
        homeDirectory: home,
      }),
    ).toMatchObject({ ok: false, reason });
  });

  it('rejects a file that is not readable by the current service user', () => {
    const { home, cwd } = fixture();
    const target = path.join(cwd, 'runtime.md');
    writeFileSync(target, 'instructions', { mode: 0o600 });
    chmodSync(target, 0o000);

    expect(
      validateAgentInstructionsPath({
        instructionsPath: 'runtime.md',
        cwd,
        homeDirectory: home,
      }),
    ).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('rejects a symlink whose real target escapes the service-user home', () => {
    const { root, home, cwd } = fixture();
    const outside = path.join(root, 'outside.md');
    writeFileSync(outside, 'instructions', { mode: 0o600 });
    symlinkSync(outside, path.join(cwd, 'runtime.md'));

    expect(
      validateAgentInstructionsPath({
        instructionsPath: 'runtime.md',
        cwd,
        homeDirectory: home,
      }),
    ).toMatchObject({ ok: false, reason: 'outside_home' });
  });
});
