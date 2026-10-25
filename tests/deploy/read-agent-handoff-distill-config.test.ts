import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const reader = join(process.cwd(), 'deploy/lib/read-agent-handoff-distill-config.mjs');

function config(value: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-handoff-config-'));
  roots.push(root);
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ name: 'fixture-agent', type: 'agent', ...value }), { mode: 0o600 });
  return path;
}

function read(path: string): string {
  return execFileSync(process.execPath, [reader, path, 'fixture-agent'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function runLauncherProjection(handoff: unknown, legacyModel?: string, shape?: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  lookupLog: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-handoff-launcher-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const configHome = join(root, 'config');
  const instanceDir = join(configHome, 'whatsoup', 'instances', 'fixture-agent');
  const lookupLog = join(root, 'lookups.log');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(instanceDir, 'config.json'), JSON.stringify({
    name: shape === 'mismatch' ? 'other-agent' : 'fixture-agent', type: 'agent', agentOptions: handoff === undefined ? {} : { handoffDistill: handoff },
  }), { mode: 0o600 });
  const instanceConfig = join(instanceDir, 'config.json');
  if (shape === 'symlink') {
    const target = join(root, 'target.json');
    renameSync(instanceConfig, target);
    symlinkSync(target, instanceConfig);
  } else if (shape === 'directory') {
    renameSync(instanceConfig, join(root, 'saved.json'));
    mkdirSync(instanceConfig);
  } else if (shape === 'fifo') {
    renameSync(instanceConfig, join(root, 'saved.json'));
    execFileSync('mkfifo', [instanceConfig], { timeout: 5_000 });
  } else if (shape === 'parent-symlink') {
    const target = instanceDir + '.original';
    renameSync(instanceDir, target);
    symlinkSync(target, instanceDir);
  } else if (shape === 'non-private') {
    chmodSync(instanceConfig, 0o644);
  }
  writeFileSync(join(bin, 'uname'), '#!/usr/bin/env bash\nprintf "Darwin\\n"\n', { mode: 0o700 });
  writeFileSync(join(bin, 'security'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$LOOKUP_LOG"',
    'if [ "$1" = "find-generic-password" ] && [ "${3:-}" = "deepseek" ]; then printf "synthetic-key\\n"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(join(bin, 'uname'), 0o700);
  chmodSync(join(bin, 'security'), 0o700);

  const source = readFileSync('deploy/whatsoup', 'utf8');
  const probe = join(root, 'projection-probe.sh');
  writeFileSync(probe, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'INSTANCE=fixture-agent',
    between(source, '_DISTILL_CAPTURE_DEEPSEEK=', '\n\n# POSIX-portable symlink resolution'),
    `NODE=${JSON.stringify(process.execPath)}`,
    `SCRIPT_DIR=${JSON.stringify(join(process.cwd(), 'deploy'))}`,
    `. ${JSON.stringify(join(process.cwd(), 'deploy/lib/bounded-exec.sh'))}`,
    between(source, 'macos_keychain_lookup() {', '\n# Pinned Node path'),
    between(source, '# Detect instance type', '\n# Health server auth token').replace(
      'HANDOFF_TYPED_PROJECTION="legacy"',
      shape === 'replacement'
        ? 'mv "$INSTANCE_JSON" "$INSTANCE_JSON.original"; ln -s "$INSTANCE_JSON.original" "$INSTANCE_JSON"\nHANDOFF_TYPED_PROJECTION="legacy"'
        : 'HANDOFF_TYPED_PROJECTION="legacy"',
    ),
    'printf "deepseek=%s minimax=%s zai=%s\\n" "${DEEPSEEK_API_KEY:+set}" "${MINIMAX_API_KEY:+set}" "${ZAI_API_KEY:+set}"',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(probe, 0o700);

  const result = spawnSync('/bin/bash', [probe], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: root,
      USER: 'fixture-user',
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: join(root, 'data'),
      TMPDIR: root,
      LOOKUP_LOG: lookupLog,
      DEEPSEEK_API_KEY: 'synthetic-inherited-key',
      ...(legacyModel === undefined ? {} : { WHATSOUP_HANDOFF_DISTILL_MODEL: legacyModel }),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    lookupLog: existsSync(lookupLog) ? readFileSync(lookupLog, 'utf8') : '',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('read-agent-handoff-distill-config', () => {
  it.each([
    { globalConcurrency: 0 },
    { globalConcurrency: 1.5 },
    { contextInjection: 'true' },
    { unknownOption: true },
    { sweepMs: 9_999 },
    { maxCallsPerWindow: 1_001 },
  ])('rejects invalid typed settings %j before credential lookup', (invalid) => {
    const result = runLauncherProjection({
      enabled: true, provider: 'deepseek', model: 'deepseek-flash', ...invalid,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: malformed agentOptions.handoffDistill credential projection');
    expect(result.lookupLog).toBe('');
    expect(result.stdout).not.toContain('deepseek=set');
  });

  it.each(['symlink', 'parent-symlink', 'directory', 'fifo', 'replacement', 'non-private', 'mismatch'])(
    'refuses %s config before handoff credential lookup', (shape) => {
      const result = runLauncherProjection({ enabled: true, provider: 'deepseek', model: 'deepseek-flash' }, undefined, shape);
      expect(result.status).not.toBe(0);
      expect(result.lookupLog).not.toContain('find-generic-password -s deepseek');
      expect(result.stdout).not.toContain('deepseek=set');
    },
  );

  it('rechecks a config replaced by a symlink after an admitted read', () => {
    const path = config({ agentOptions: { handoffDistill: { enabled: true, provider: 'deepseek', model: 'deepseek-flash' } } });
    expect(read(path)).toBe('deepseek-flash');
    const target = path + '.original';
    renameSync(path, target);
    symlinkSync(target, path);
    expect(() => read(path)).toThrow();
  });

  it('preserves legacy launcher behavior when the typed object is absent', () => {
    expect(read(config({ agentOptions: {} }))).toBe('legacy');
  });

  it('returns disabled for an explicit kill switch', () => {
    expect(read(config({ agentOptions: { handoffDistill: { enabled: false } } }))).toBe('disabled');
  });

  it('admits only the exact DeepSeek Flash projection', () => {
    expect(read(config({
      agentOptions: {
        handoffDistill: { enabled: true, provider: 'deepseek', model: 'deepseek-flash' },
      },
    }))).toBe('deepseek-flash');
  });

  it('refuses an enabled arbitrary model rather than projecting a provider key', () => {
    const path = config({
      agentOptions: {
        handoffDistill: { enabled: true, provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    });
    expect(() => read(path)).toThrow();
  });

  it('has a DeepSeek-only typed projection branch and leaves other providers to legacy mode', () => {
    const wrapper = readFileSync('deploy/whatsoup', 'utf8');
    const start = wrapper.indexOf('case "$HANDOFF_TYPED_PROJECTION" in');
    const legacy = wrapper.indexOf('    legacy)', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeGreaterThan(start);
    const typedBranch = wrapper.slice(start, legacy);
    expect(typedBranch).toContain('deepseek-flash)');
    expect(typedBranch).toContain('keyring_lookup deepseek DEEPSEEK_API_KEY');
    expect(typedBranch).not.toContain('keyring_lookup minimax');
    expect(typedBranch).not.toContain('keyring_lookup zai');
  });

  it('keeps an absent typed object on the legacy projection route', () => {
    const result = runLauncherProjection(undefined, 'deepseek-chat');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('deepseek=set minimax= zai=');
    expect(result.lookupLog).toContain('find-generic-password -s deepseek');
  });

  it('makes an explicit disabled object suppress legacy projection and all handoff keys', () => {
    const result = runLauncherProjection({ enabled: false }, 'deepseek-chat');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('deepseek= minimax= zai=');
    expect(result.lookupLog).not.toContain('find-generic-password -s deepseek');
  });

  it('refuses an unsupported typed object before any DeepSeek credential lookup', () => {
    const result = runLauncherProjection({ enabled: true, provider: 'deepseek', model: 'deepseek-v4-pro' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: handoff-distill credential projection refused');
    expect(result.lookupLog).not.toContain('find-generic-password -s deepseek');
  });

  it('projects only DeepSeek Flash for an enabled typed object', () => {
    const result = runLauncherProjection({ enabled: true, provider: 'deepseek', model: 'deepseek-flash' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('deepseek=set minimax= zai=');
    expect(result.lookupLog).toContain('find-generic-password -s deepseek');
  });
});
