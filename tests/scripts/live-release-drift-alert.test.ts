import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleaseSnapshotPlan } from '../../scripts/release-snapshot-plan.ts';
import { checkLiveReleaseDrift, resolveReleasePathFromLaunchdPlist } from '../../scripts/live-release-drift-alert.ts';

const CORRELATION_DIGEST_DOMAIN = 'whatsoup-release-drift-correlation-v1';

function correlationDigestFor(eventId: string): string {
  return createHash('sha256').update(`${CORRELATION_DIGEST_DOMAIN}|${eventId}`).digest('hex');
}

function parseRecordLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  expect(lines.length, `expected exactly one record line, got ${lines.length}: ${stdout}`).toBe(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    scriptPath,
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

let tmpRoot = '';
const oldBotErrorsStateDir = process.env.BOT_ERRORS_STATE_DIR;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  if (oldBotErrorsStateDir === undefined) delete process.env.BOT_ERRORS_STATE_DIR;
  else process.env.BOT_ERRORS_STATE_DIR = oldBotErrorsStateDir;
  process.exitCode = undefined;
});

function writeFixtureRelease(options: { drift?: boolean } = {}) {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  const releaseRoot = path.join(tmpRoot, 'releases');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const value = true;\n', 'utf8');
  const plan = createReleaseSnapshotPlan({
    sourceRoot,
    sourceRef: 'HEAD',
    sourceCommit: 'abc123def4567890',
    releaseRoot,
    buildTime: '2026-06-14T06:00:00.000Z',
    trackedFiles: ['package.json', 'src/main.ts'],
  });
  const releasePath = plan.manifest.release.path;
  mkdirSync(path.join(releasePath, 'src'), { recursive: true });
  writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
  writeFileSync(
    path.join(releasePath, 'src/main.ts'),
    options.drift ? 'export const value = false;\n' : readFileSync(path.join(sourceRoot, 'src/main.ts')),
    'utf8',
  );
  writeFileSync(
    path.join(releasePath, '.whatsoup-release-manifest.json'),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    'utf8',
  );
  return { releasePath, sourceRoot };
}

function outboxEvents(stateDir: string): Array<Record<string, unknown>> {
  const outbox = path.join(stateDir, 'outbox');
  return readdirSync(outbox)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(outbox, name), 'utf8')) as Record<string, unknown>);
}

function writeLaunchdPlist(releasePath: string): string {
  const plistPath = path.join(tmpRoot, 'com.whatsoup.release-bot.plist');
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.release-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${releasePath}/src/bootstrap.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${releasePath}</string>
</dict>
</plist>
`, 'utf8');
  return plistPath;
}

describe('live release drift alert', () => {
  it('passes a clean release without emitting by default', () => {
    const { releasePath } = writeFixtureRelease();

    const result = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath,
      instance: 'release-bot',
      source: 'release-drift',
      emit: true,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
    });

    expect(result).toMatchObject({
      check: 'live-release-drift-alert',
      ok: true,
      releasePath,
      issues: [],
      alert: {
        required: false,
        attempted: false,
        kind: null,
      },
    });
  });

  it('queues a sanitized BOT ERRORS alert when release files drift', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });
    const stateDir = path.join(tmpRoot, 'bot-errors-state');
    process.env.BOT_ERRORS_STATE_DIR = stateDir;

    const result = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath,
      instance: 'release-bot',
      source: 'release-drift',
      emit: true,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
    });

    expect(result.ok).toBe(false);
    expect(result.alert).toMatchObject({
      required: true,
      attempted: true,
      kind: 'alert',
      status: 0,
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' }),
    ]);
    const [event] = outboxEvents(stateDir);
    expect(event).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'release-bot',
      source: 'release-drift',
    });
    expect(String(event.summary)).toContain('release drift detected');
    expect(String(event.evidence)).toContain('file-sha256-drift');
    expect(String(event.evidence)).toContain('src/main.ts');
  });

  it('CLI no-emit mode still exits nonzero on drift without writing an alert', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release',
      releasePath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: stateDir,
      },
    });

    expect(proc.status).toBe(1);
    expect(proc.stderr).toBe('');
    const result = JSON.parse(proc.stdout) as ReturnType<typeof checkLiveReleaseDrift>;
    expect(result).toMatchObject({
      ok: false,
      alert: {
        required: true,
        attempted: false,
        kind: 'alert',
      },
    });
    expect(() => readdirSync(path.join(stateDir, 'outbox'))).toThrow(/ENOENT/);
  });

  it('resolves the release path from a launchd plist WorkingDirectory', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);

    expect(resolveReleasePathFromLaunchdPlist(plistPath)).toBe(releasePath);
  });

  it('CLI accepts launchd plist mode for the currently configured release path', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--launchd-plist',
      plistPath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    const result = JSON.parse(proc.stdout) as ReturnType<typeof checkLiveReleaseDrift>;
    expect(result).toMatchObject({
      ok: true,
      releasePath,
      alert: {
        required: false,
        attempted: false,
      },
    });
  });

  it('rejects ambiguous release and launchd plist input', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release',
      releasePath,
      '--launchd-plist',
      plistPath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('--release and --launchd-plist are mutually exclusive');
  });
});

describe('live release drift alert #2458: per-invocation structured log record', () => {
  it('prints exactly one structured record with parseable UTC observedAt on a passing check', () => {
    const { releasePath } = writeFixtureRelease();

    const proc = runCli(['--release', releasePath, '--no-emit']);

    expect(proc.status, proc.stderr).toBe(0);
    const record = parseRecordLine(proc.stdout);
    expect(record).toMatchObject({
      schemaVersion: 1,
      check: 'live-release-drift-alert',
      ok: true,
      outcome: 'passed',
      issueKinds: {},
      alert: { required: false, attempted: false, kind: null, status: null },
    });
    expect(typeof record.observedAt).toBe('string');
    expect(String(record.observedAt)).toMatch(/Z$/);
    expect(Number.isFinite(Date.parse(String(record.observedAt)))).toBe(true);
    expect(record.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(record.conditionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Independent recomputation — never compare the record to itself: the
    // digest contract is sha256('whatsoup-release-drift-manifest-v1|' + manifest bytes).
    const expectedDigest = createHash('sha256')
      .update(`whatsoup-release-drift-manifest-v1|${readFileSync(path.join(releasePath, '.whatsoup-release-manifest.json'), 'utf8')}`)
      .digest('hex');
    expect(record.desiredReleaseDigest).toBe(expectedDigest);
    expect(record.observedReleaseDigest).toBe(expectedDigest);
    expect(record.correlationDigest).toBeNull();
    // Terminal closed-world pin: the record carries exactly the schema-v1 keys —
    // an accidental new field (or a dropped one) fails here, not in a consumer.
    expect(Object.keys(record).sort()).toEqual([
      'alert', 'check', 'conditionFingerprint', 'correlationDigest', 'desiredReleaseDigest',
      'invocationId', 'issueKinds', 'observedAt', 'observedReleaseDigest', 'ok', 'outcome',
      'schemaVersion',
    ]);
  });

  it('records a bounded drift outcome and joins to the emitted BOT ERRORS event via correlationDigest', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = runCli(['--release', releasePath], { BOT_ERRORS_STATE_DIR: stateDir });

    expect(proc.status, proc.stderr).toBe(1);
    const record = parseRecordLine(proc.stdout);
    expect(record).toMatchObject({
      ok: false,
      outcome: 'drift',
      issueKinds: { 'file-sha256-drift': 1 },
      alert: { required: true, attempted: true, kind: 'alert', status: 0 },
    });
    expect(proc.stdout).not.toContain('src/main.ts');
    expect(proc.stdout).not.toContain(tmpRoot);

    const [event] = outboxEvents(stateDir);
    expect(typeof event.id).toBe('string');
    expect(record.correlationDigest).toBe(correlationDigestFor(String(event.id)));
    expect(proc.stdout).not.toContain(String(event.id));
  });

  it('repeats one conditionFingerprint across identical conditions and changes it on a different issue kind', () => {
    const driftA = writeFixtureRelease({ drift: true });
    const first = parseRecordLine(runCli(['--release', driftA.releasePath, '--no-emit']).stdout);
    const second = parseRecordLine(runCli(['--release', driftA.releasePath, '--no-emit']).stdout);
    expect(first.conditionFingerprint).toBe(second.conditionFingerprint);
    expect(first.invocationId).not.toBe(second.invocationId);

    writeFileSync(path.join(driftA.releasePath, 'untracked-extra.txt'), 'extra\n', 'utf8');
    const third = parseRecordLine(runCli(['--release', driftA.releasePath, '--no-emit']).stdout);
    expect(third.conditionFingerprint).not.toBe(first.conditionFingerprint);
    expect(third.issueKinds).toEqual({ 'extra-file': 1, 'file-sha256-drift': 1 });
  });

  it('emits a checker_failed record without leaking paths when the manifest is unreadable', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
    const releasePath = path.join(tmpRoot, 'broken-release');
    mkdirSync(releasePath);
    writeFileSync(path.join(releasePath, '.whatsoup-release-manifest.json'), '{not-json', 'utf8');

    const proc = runCli(['--release', releasePath, '--no-emit']);

    expect(proc.status, proc.stderr).toBe(2);
    expect(proc.stderr).toBe('');
    const record = parseRecordLine(proc.stdout);
    expect(record).toMatchObject({
      schemaVersion: 1,
      ok: false,
      outcome: 'checker_failed',
      issueKinds: {},
      desiredReleaseDigest: 'unknown',
      observedReleaseDigest: 'unknown',
      alert: { required: false, attempted: false, kind: null, status: null },
    });
    expect(record.conditionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(proc.stdout).not.toContain(tmpRoot);
  });

  it('records emit_failed with a nonzero exit when the BOT ERRORS helper cannot run', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });

    const proc = runCli(['--release', releasePath, '--python', '/nonexistent/python-binary']);

    expect(proc.status, proc.stderr).not.toBe(0);
    const record = parseRecordLine(proc.stdout);
    expect(record).toMatchObject({
      ok: false,
      outcome: 'emit_failed',
      issueKinds: { 'file-sha256-drift': 1 },
      alert: { required: true, attempted: true, kind: 'alert', status: 1 },
    });
  });

  it('accepts an injected clock for deterministic observedAt', () => {
    const { releasePath } = writeFixtureRelease();

    const result = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath,
      instance: 'release-bot',
      source: 'release-drift',
      emit: false,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
      now: () => new Date('2026-08-21T12:34:56.000Z'),
    });

    expect(result.record.observedAt).toBe('2026-08-21T12:34:56.000Z');
  });
});
