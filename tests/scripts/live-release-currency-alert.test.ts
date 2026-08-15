import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkLiveReleaseCurrency,
  type ReleaseTargetResolver,
} from '../../scripts/live-release-currency-alert.ts';

const DEPLOYED = '1111111111111111111111111111111111111111';
const TARGET = '2222222222222222222222222222222222222222';
let tmpRoot = '';
const oldStateDir = process.env.BOT_ERRORS_STATE_DIR;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  if (oldStateDir === undefined) delete process.env.BOT_ERRORS_STATE_DIR;
  else process.env.BOT_ERRORS_STATE_DIR = oldStateDir;
  vi.useRealTimers();
});

function writeRelease(commit = DEPLOYED): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-currency-'));
  const releasePath = path.join(tmpRoot, 'WhatSoup-release-fixture');
  mkdirSync(releasePath, { recursive: true });
  writeFileSync(path.join(releasePath, '.whatsoup-release-manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    source: { ref: 'approved-release', commit },
    release: {
      path: releasePath,
      createdAt: '2026-08-15T12:00:00.000Z',
      mutablePathExcludes: [],
    },
    rollback: { path: path.join(tmpRoot, 'rollback') },
    files: [],
    requiredOutputs: [],
  })}\n`, 'utf8');
  return releasePath;
}

function resolver(result: Awaited<ReturnType<ReleaseTargetResolver>>): ReleaseTargetResolver {
  return vi.fn().mockResolvedValue(result);
}

function options(releasePath: string, resolveTarget: ReleaseTargetResolver) {
  return {
    repoRoot: process.cwd(),
    releasePath,
    targetUrl: 'https://github.com/LucasQuiles/WhatSoup.git',
    targetRef: 'refs/heads/main',
    instance: 'sample-bot',
    source: 'release-currency',
    emit: false,
    emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
    python: 'python3',
    clearOnCurrent: false,
    resolveTarget,
  };
}

describe('live release currency alert', () => {
  it('rejects another flag where --target-url requires a value', () => {
    const releasePath = writeRelease();
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-currency-alert.ts');
    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release', releasePath,
      '--target-url', '--json',
      '--no-emit',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('the next argument is another flag (--json)');
  });

  it('reports current only when exact full object IDs match', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T21:00:00.000Z'));
    const releasePath = writeRelease();

    const result = await checkLiveReleaseCurrency(options(releasePath, resolver({
      ok: true,
      commit: DEPLOYED,
    })));

    expect(result).toMatchObject({
      check: 'live-release-currency-alert',
      state: 'current',
      healthImpact: 'none',
      observedAt: '2026-08-15T21:00:00.000Z',
      deployed: { commit: DEPLOYED, ref: 'approved-release' },
      target: { commit: DEPLOYED, ref: 'refs/heads/main' },
      alert: { required: false, attempted: false, kind: null },
    });
  });

  it('reports target-differs without claiming behind, ahead, or divergence', async () => {
    const releasePath = writeRelease();

    const result = await checkLiveReleaseCurrency(options(releasePath, resolver({
      ok: true,
      commit: TARGET,
    })));

    expect(result).toMatchObject({
      state: 'target-differs',
      reason: 'exact-commit-mismatch',
      deployed: { commit: DEPLOYED },
      target: { commit: TARGET },
    });
    expect(JSON.stringify(result)).not.toMatch(/\bbehind\b|\bahead\b|\bdiverged\b/);
  });

  it('fails closed as inconclusive when target evidence is unavailable', async () => {
    const releasePath = writeRelease();

    const result = await checkLiveReleaseCurrency(options(releasePath, resolver({
      ok: false,
      reason: 'target-unavailable',
      detail: 'remote observation timed out',
    })));

    expect(result).toMatchObject({
      state: 'inconclusive',
      reason: 'target-unavailable',
      target: { commit: null },
      resolutionHint: expect.stringContaining('remote/ref/network'),
    });
  });

  it('rejects an unsafe Git transport before invoking the resolver', async () => {
    const releasePath = writeRelease();
    const resolveTarget = resolver({ ok: true, commit: DEPLOYED });
    const unsafe = options(releasePath, resolveTarget);
    unsafe.targetUrl = 'ext::sh -c touch /tmp/not-allowed';

    const result = await checkLiveReleaseCurrency(unsafe);

    expect(result).toMatchObject({ state: 'inconclusive', reason: 'unsafe-target-url' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('treats a malformed manifest commit as inconclusive without resolving the target', async () => {
    const releasePath = writeRelease('short-sha');
    const resolveTarget = resolver({ ok: true, commit: DEPLOYED });

    const result = await checkLiveReleaseCurrency(options(releasePath, resolveTarget));

    expect(result).toMatchObject({ state: 'inconclusive', reason: 'invalid-deployed-commit' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('distinguishes missing and malformed manifest evidence', async () => {
    const releasePath = writeRelease();
    const manifestPath = path.join(releasePath, '.whatsoup-release-manifest.json');
    rmSync(manifestPath);
    const resolveTarget = resolver({ ok: true, commit: DEPLOYED });

    const missing = await checkLiveReleaseCurrency(options(releasePath, resolveTarget));
    expect(missing).toMatchObject({ state: 'inconclusive', reason: 'manifest-unavailable' });

    writeFileSync(manifestPath, '{not-json\n');
    const malformed = await checkLiveReleaseCurrency(options(releasePath, resolveTarget));
    expect(malformed).toMatchObject({ state: 'inconclusive', reason: 'manifest-invalid' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('rejects a valid manifest that belongs to a different release path', async () => {
    const releasePath = writeRelease();
    const manifestPath = path.join(releasePath, '.whatsoup-release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as any;
    manifest.release.path = path.join(tmpRoot, 'different-release');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const resolveTarget = resolver({ ok: true, commit: DEPLOYED });

    const result = await checkLiveReleaseCurrency(options(releasePath, resolveTarget));

    expect(result).toMatchObject({ state: 'inconclusive', reason: 'manifest-release-path-mismatch' });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('emits a separate warning with a no-blind-deploy resolution hint', async () => {
    const releasePath = writeRelease();
    const stateDir = path.join(tmpRoot, 'bot-errors-state');
    process.env.BOT_ERRORS_STATE_DIR = stateDir;
    const configured = options(releasePath, resolver({ ok: true, commit: TARGET }));
    configured.emit = true;

    const result = await checkLiveReleaseCurrency(configured);

    expect(result.alert).toMatchObject({ required: true, attempted: true, kind: 'alert', status: 0 });
    const eventFiles = readdirSync(path.join(stateDir, 'outbox')).filter((name) => name.endsWith('.json'));
    expect(eventFiles).toHaveLength(1);
    const event = JSON.parse(readFileSync(path.join(stateDir, 'outbox', eventFiles[0]), 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'alert',
      severity: 'warning',
      instance: 'sample-bot',
      source: 'release-currency',
    });
    expect(String(event.summary)).toContain('target differs');
    expect(String(event.evidence)).toContain('does not authorize deploying the target');
  });

  it('emits a source-matched clear only when explicitly enabled and current', async () => {
    const releasePath = writeRelease();
    const stateDir = path.join(tmpRoot, 'bot-errors-state');
    process.env.BOT_ERRORS_STATE_DIR = stateDir;
    const configured = options(releasePath, resolver({ ok: true, commit: DEPLOYED }));
    configured.emit = true;
    configured.clearOnCurrent = true;

    const result = await checkLiveReleaseCurrency(configured);

    expect(result).toMatchObject({
      state: 'current',
      alert: { required: true, attempted: true, kind: 'clear', status: 0 },
    });
    const eventFiles = readdirSync(path.join(stateDir, 'outbox')).filter((name) => name.endsWith('.json'));
    expect(eventFiles).toHaveLength(1);
    const event = JSON.parse(readFileSync(path.join(stateDir, 'outbox', eventFiles[0]), 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: 'clear',
      severity: 'info',
      instance: 'sample-bot',
      source: 'release-currency',
    });
  });
});
