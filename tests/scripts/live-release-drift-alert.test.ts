import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReleaseSnapshotPlan } from '../../scripts/release-snapshot-plan.ts';
import {
  checkLiveReleaseDrift,
  containedReleaseIdentity,
  releaseIdentityFromManifestText,
  resolveReleasePathFromLaunchdPlist,
  type DriftKindField,
  type DriftKindMember,
} from '../../scripts/live-release-drift-alert.ts';

/**
 * Control for the poisoned-parser test below. `vi.mock` is hoisted above the
 * imports, so the control object must be hoisted with it. While failFromCall is
 * 0 the mock is a pass-through and every other test sees the real parser.
 */
const parseControl = vi.hoisted(() => ({ calls: 0, failFromCall: 0 }));

vi.mock('../../scripts/release-snapshot-plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/release-snapshot-plan.ts')>();
  return {
    ...actual,
    parseReleaseSnapshotManifest: (payload: unknown) => {
      parseControl.calls += 1;
      if (parseControl.failFromCall > 0 && parseControl.calls >= parseControl.failFromCall) {
        throw new TypeError('poisoned identity parse');
      }
      return actual.parseReleaseSnapshotManifest(payload);
    },
  };
});

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

function writeLaunchdPlist(releasePath: string, options: { workingDirectory?: string; name?: string } = {}): string {
  const name = options.name ?? 'com.whatsoup.release-bot';
  const plistPath = path.join(tmpRoot, `${name}.plist`);
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${releasePath}/src/bootstrap.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${options.workingDirectory ?? releasePath}</string>
</dict>
</plist>
`, 'utf8');
  return plistPath;
}

/**
 * The mini11 false-pass shape: the job really runs release A (selected by
 * `ProgramArguments`) while a hand-edited `WorkingDirectory` names release B.
 * Both releases are content-clean, so the ONLY thing that can fail the check is
 * the selector disagreement itself.
 */
function writeFalsePassFixture(): { running: string; stale: string; plistPath: string } {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
  const build = (commit: string): string => {
    const sourceRoot = path.join(tmpRoot, `source-${commit}`);
    mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const value = true;\n', 'utf8');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'HEAD',
      sourceCommit: commit,
      releaseRoot: path.join(tmpRoot, 'releases'),
      buildTime: '2026-06-14T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), readFileSync(path.join(sourceRoot, 'src/main.ts')));
    writeFileSync(
      path.join(releasePath, '.whatsoup-release-manifest.json'),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
      'utf8',
    );
    return releasePath;
  };
  const running = build('aaaaaaaaaaaa1111');
  const stale = build('bbbbbbbbbbbb2222');
  return { running, stale, plistPath: writeLaunchdPlist(running, { workingDirectory: stale }) };
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

  it('resolves the release path from ProgramArguments, not WorkingDirectory', () => {
    const { running, plistPath } = writeFalsePassFixture();

    expect(resolveReleasePathFromLaunchdPlist(plistPath)).toBe(running);
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

describe('live release drift alert: launchd selector disagreement', () => {
  it('fails a content-clean release whose WorkingDirectory names a different release', () => {
    const { running, stale, plistPath } = writeFalsePassFixture();
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = runCli(['--launchd-plist', plistPath, '--json'], { BOT_ERRORS_STATE_DIR: stateDir });

    // The mini11 signature: every file under the running release verifies, so
    // release-content drift is empty and the old observer reported green.
    expect(proc.status, proc.stderr).toBe(1);
    const result = JSON.parse(proc.stdout) as {
      ok: boolean;
      releasePath: string;
      issues: Array<{ kind: string }>;
      alert: { required: boolean; kind: string | null };
    };
    expect(result.ok).toBe(false);
    expect(result.releasePath).toBe(running);
    expect(result.issues.map((issue) => issue.kind)).toEqual(['launchd-working-directory-mismatch']);
    expect(result.alert).toMatchObject({ required: true, kind: 'alert' });

    // The operator must be able to see WHICH release each side named.
    const [event] = outboxEvents(stateDir);
    expect(String(event.evidence)).toContain(running);
    expect(String(event.evidence)).toContain(stale);
  });

  it('does not emit a clear event for a disagreeing job under --clear-on-ok', () => {
    const { plistPath } = writeFalsePassFixture();
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = runCli(['--launchd-plist', plistPath, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDir });

    expect(proc.status, proc.stderr).toBe(1);
    expect(outboxEvents(stateDir).map((event) => event.eventType)).toEqual(['alert']);
  });

  it('counts the disagreement in the content-free record without naming either release', () => {
    const { running, stale, plistPath } = writeFalsePassFixture();

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit']);

    const record = parseRecordLine(proc.stdout);
    expect(record).toMatchObject({
      ok: false,
      outcome: 'drift',
      issueKinds: { 'launchd-working-directory-mismatch': 1 },
    });
    expect(proc.stdout).not.toContain(running);
    expect(proc.stdout).not.toContain(stale);
  });

  it('passes a job whose WorkingDirectory agrees with the real selector', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit']);

    expect(proc.status, proc.stderr).toBe(0);
    expect(parseRecordLine(proc.stdout)).toMatchObject({ ok: true, outcome: 'passed', issueKinds: {} });
  });

  it('fails closed when no ProgramArguments entry resolves to a release', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = path.join(tmpRoot, 'com.whatsoup.unresolvable.plist');
    // WorkingDirectory still names a real release: the old code would have
    // checked it and reported a pass for a job it could not actually locate.
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.unresolvable</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${path.join(tmpRoot, 'nowhere/run.sh')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${releasePath}</string>
</dict>
</plist>
`, 'utf8');

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit']);

    expect(proc.status, proc.stderr).toBe(2);
    expect(proc.stderr).toBe('');
    expect(parseRecordLine(proc.stdout)).toMatchObject({ ok: false, outcome: 'checker_failed' });
    expect(proc.stdout).not.toContain(tmpRoot);
  });

  /**
   * The structural `deploy/` rule resolves `<dir>/deploy/<exe>` to `<dir>`
   * WITHOUT consulting a manifest, so it can name a directory that is not a
   * release at all. That is deliberate — the wrapper computes REPO_ROOT the
   * same way whether or not a manifest exists — but it is only safe if the
   * checker then REFUSES the path instead of treating an unverifiable
   * directory as clean. This pins the refusal: a manifest-less job must alert,
   * never report a quiet pass.
   */
  it('refuses a manifest-less directory reached through the structural deploy/ rule', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
    const fakeRelease = path.join(tmpRoot, 'fake-release');
    mkdirSync(path.join(fakeRelease, 'deploy'), { recursive: true });
    writeFileSync(path.join(fakeRelease, 'deploy/whatsoup'), '#!/bin/sh\nexit 0\n', 'utf8');
    const plistPath = path.join(tmpRoot, 'com.whatsoup.manifestless.plist');
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.manifestless</string>
  <key>ProgramArguments</key>
  <array>
    <string>${path.join(fakeRelease, 'deploy/whatsoup')}</string>
    <string>ph-bot</string>
  </array>
</dict>
</plist>
`, 'utf8');

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit']);

    expect(proc.status, proc.stderr).not.toBe(0);
    expect(parseRecordLine(proc.stdout)).toMatchObject({
      ok: false,
      outcome: 'drift',
      issueKinds: { 'manifest-missing': 1 },
      alert: { required: true },
    });
  });

  /**
   * A `WorkingDirectory` that is not inside any release (a development
   * checkout, say) resolves to nothing. The cross-check must then stay silent
   * rather than invent a disagreement — otherwise every dev-shaped job would
   * alert on a difference that does not exist.
   */
  it('raises no disagreement when WorkingDirectory is not inside any release', () => {
    const { releasePath } = writeFixtureRelease();
    const nonRelease = path.join(tmpRoot, 'a-git-checkout');
    mkdirSync(nonRelease, { recursive: true });
    const plistPath = writeLaunchdPlist(releasePath, { workingDirectory: nonRelease });

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit']);

    expect(proc.status, proc.stderr).toBe(0);
    expect(parseRecordLine(proc.stdout)).toMatchObject({ ok: true, outcome: 'passed', issueKinds: {} });
  });
});

describe('live release drift alert: multi-job coverage', () => {
  it('checks every repeated --launchd-plist and prints one record per job', () => {
    const { running, stale, plistPath } = writeFalsePassFixture();
    const cleanPlist = writeLaunchdPlist(stale, { name: 'com.whatsoup.harness-maintenance' });

    const proc = runCli(['--launchd-plist', plistPath, '--launchd-plist', cleanPlist, '--no-emit']);

    const records = proc.stdout.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ ok: false, issueKinds: { 'launchd-working-directory-mismatch': 1 } });
    expect(records[1]).toMatchObject({ ok: true, outcome: 'passed' });
    // Worst status across the set wins; one healthy job cannot mask a bad one.
    expect(proc.status).toBe(1);
    expect(proc.stdout).not.toContain(running);
  });

  it('reports the worst outcome when one job is unresolvable and another is clean', () => {
    const { releasePath } = writeFixtureRelease();
    const cleanPlist = writeLaunchdPlist(releasePath);
    const brokenPlist = writeLaunchdPlist(path.join(tmpRoot, 'nowhere'), { name: 'com.whatsoup.broken' });

    const proc = runCli(['--launchd-plist', cleanPlist, '--launchd-plist', brokenPlist, '--no-emit']);

    expect(proc.status).toBe(2);
    const outcomes = proc.stdout.split('\n').filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { outcome: string }).outcome);
    expect(outcomes).toEqual(['passed', 'checker_failed']);
  });

  it('keeps a single --launchd-plist invocation on the one-record contract', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);

    const proc = runCli(['--launchd-plist', plistPath, '--no-emit', '--json']);

    expect(proc.status, proc.stderr).toBe(0);
    // --json still prints ONE object, not an array, for a single target.
    const result = JSON.parse(proc.stdout) as { check: string; releasePath: string };
    expect(result).toMatchObject({ check: 'live-release-drift-alert', releasePath });
  });

  it('refuses --clear-on-ok across several jobs, because one clear would cancel another job alert', () => {
    const { plistPath } = writeFalsePassFixture();
    const cleanPlist = writeLaunchdPlist(path.dirname(plistPath), { name: 'com.whatsoup.other' });

    const proc = runCli(['--launchd-plist', plistPath, '--launchd-plist', cleanPlist, '--clear-on-ok']);

    // BOT ERRORS keys incidents by machine|instance|source, and every target in
    // one invocation shares that key: a clean job's clear would resolve the
    // incident a drifted job just opened.
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('--clear-on-ok');
  });

  it('still allows --clear-on-ok for a single job', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = runCli(['--launchd-plist', plistPath, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDir });

    expect(proc.status, proc.stderr).toBe(0);
    expect(outboxEvents(stateDir).map((event) => event.eventType)).toEqual(['clear']);
  });

  it('still rejects --release combined with a repeated --launchd-plist', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);

    const proc = runCli(['--release', releasePath, '--launchd-plist', plistPath, '--launchd-plist', plistPath]);

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

/**
 * #2385 L1a and L1b. The release directory basename is an accident of a rollout,
 * not an identity: two hosts running the same bytes under different directory
 * names are the same release. L1a put the typed, path-free identity on the event.
 * L1b took the basename out of the human-readable summary, which is
 * `storm_fingerprint` input, so those two hosts now normalise to one fingerprint
 * and land in one incident group instead of two.
 *
 * Re-keying was the accepted cost, not an oversight: alerts carrying the old text
 * and alerts carrying the new one fingerprint differently, so the owner ruling
 * accepted one 120-second storm window split across both texts at cutover.
 */
const RELEASE_IDENTITY_DOMAIN = 'whatsoup-release-identity-v1';
const FIXTURE_RELEASE_NAME_A = 'WhatSoup-release-alpha';
const FIXTURE_RELEASE_NAME_B = 'WhatSoup-release-bravo';
const FIXTURE_SOURCE_COMMIT = 'abc123def4567890';
/** A second commit, so two fixtures can be genuinely different releases. */
const FIXTURE_SOURCE_COMMIT_OTHER = '0f1e2d3c4b5a6978';
const FIXTURE_BUILD_TIME = '2026-06-14T06:00:00.000Z';

/**
 * The summary text `alertSummary` emits after L1b, pinned byte-for-byte and
 * deliberately not derived from either fixture name: a constant built from
 * `FIXTURE_RELEASE_NAME_*` would still pass if the basename came back, because
 * both sides of the comparison would move together.
 *
 * The issue count stays in the text. It is a property of the drift rather than
 * of the release: two hosts on the same release that drift to different extents
 * report different counts and do land in different groups, so what groups is
 * hosts that drifted the same way. The recovered form carries no count, because
 * a recovered release has no issues to count.
 *
 * The trailing identity token is a parameter rather than a constant because it
 * varies with the release, which is the whole point of carrying it. The literal
 * text around it stays hand-written for the same reason the fixture names are
 * not interpolated: only the token may move between an expectation and the
 * emitted string. Callers pass `expectedIdentityToken(...)`, which truncates an
 * oracle recomputed from the manifest on disk rather than imported from the
 * script under test, so a canonicalisation change on either side fails here.
 * The width is named there rather than spelled again here, so this block cannot
 * go stale against a deliberate widening.
 */
// Deliberately a second, independent copy of the width rather than an import of
// the literal in `releaseIdentityToken`: an oracle that took the width from the
// code under test would move with it and could not fail on a width change. The
// cost is that an intentional widening is a THREE-site change, not a two-site
// one: the slice in `releaseIdentityToken`, this constant, and the hardcoded
// width in the anchored token-shape regex further down this file. That regex is
// a second deliberate oracle and does not read this constant, so a coordinated
// widening of the first two sites still fails there.
const RELEASE_IDENTITY_TOKEN_LENGTH = 8;
const UNKNOWN_IDENTITY_TOKEN = 'unknown';

function pathFreeRecoveredSummary(token: string): string {
  return `release drift recovered release ${token}`;
}

function pathFreeDetectedSummaryOneIssue(token: string): string {
  return `release drift detected (1 issue) release ${token}`;
}

function expectedIdentityToken(manifestPath: string): string {
  const identity = expectedReleaseIdentity(manifestPath);
  // Coverage assertion on the oracle itself: a truncation of an empty or
  // sentinel identity would make every summary expectation below vacuous.
  expect(identity).toMatch(/^[0-9a-f]{64}$/);
  return identity.slice(0, RELEASE_IDENTITY_TOKEN_LENGTH);
}

/**
 * Independent oracle for the typed identity: recomputed here from the manifest
 * the fixture wrote, deliberately NOT imported from the script under test, so a
 * canonicalisation change on either side fails this test instead of hiding.
 */
function expectedReleaseIdentity(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion: number;
    source: { ref: string; commit: string };
    files: Array<{ path: string; sha256: string; sizeBytes: number }>;
    requiredOutputs: string[];
  };
  const canonical = JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    sourceRef: manifest.source.ref,
    sourceCommit: manifest.source.commit,
    files: [...manifest.files]
      .map((file) => ({
        // The oracle applies the same normalisations the schema parser applies,
        // because the identity is defined over the parsed manifest.
        path: file.path.replace(/\\/g, '/').replace(/^\.\//, ''),
        sha256: file.sha256.toLowerCase(),
        sizeBytes: file.sizeBytes,
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    requiredOutputs: [...manifest.requiredOutputs].sort(),
  });
  return createHash('sha256').update(`${RELEASE_IDENTITY_DOMAIN}|${canonical}`).digest('hex');
}

function eventDiagnostics(event: Record<string, unknown>): Record<string, string> {
  return event.diagnostics as Record<string, string>;
}

/**
 * The issue count read from the event's evidence blob, which `alertEvidence`
 * builds independently of `alertSummary`. Reading the count back out of the
 * summary would make any test that compares counts an assertion about the
 * string it is trying to explain.
 */
function eventIssueCount(event: Record<string, unknown>): number {
  const evidence = JSON.parse(String(event.evidence)) as { issueCount: number };
  return evidence.issueCount;
}

/**
 * Two releases built from one source tree at one commit, differing ONLY in
 * release directory basename. `releaseName` is passed explicitly because the
 * default derives the name from the source commit, which would make both
 * fixtures share a basename and let the identity assertion pass by coincidence.
 *
 * `sourceCommit` is an option because the identity is defined over the manifest
 * and excludes `release.path`, so every default fixture in this file has the
 * SAME identity no matter which tmp directory it lands in. A test that needs two
 * genuinely different releases therefore has to move a field the identity reads;
 * the commit is the cheapest one.
 */
function writeTwinReleases(options: { drift?: boolean; sourceCommit?: string } = {}): { a: string; b: string } {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const value = true;\n', 'utf8');

  const build = (releaseName: string): string => {
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'HEAD',
      sourceCommit: options.sourceCommit ?? FIXTURE_SOURCE_COMMIT,
      releaseRoot: path.join(tmpRoot, 'releases'),
      releaseName,
      buildTime: FIXTURE_BUILD_TIME,
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
    return releasePath;
  };

  return { a: build(FIXTURE_RELEASE_NAME_A), b: build(FIXTURE_RELEASE_NAME_B) };
}

describe('live release drift alert #2385: typed drift identity on the emitted event', () => {
  it('carries an equal typed identity for two releases that differ only in directory basename', () => {
    const { a, b } = writeTwinReleases();
    // Coverage assertion: without this the identity equality could hold because
    // both fixtures are the same directory, which would prove nothing.
    expect(path.basename(a)).not.toBe(path.basename(b));

    const stateDirA = path.join(tmpRoot, 'state-a');
    const stateDirB = path.join(tmpRoot, 'state-b');
    const procA = runCli(['--release', a, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDirA });
    const procB = runCli(['--release', b, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDirB });
    expect(procA.status, procA.stderr).toBe(0);
    expect(procB.status, procB.stderr).toBe(0);

    const [eventA] = outboxEvents(stateDirA);
    const [eventB] = outboxEvents(stateDirB);
    const diagA = eventDiagnostics(eventA);
    const diagB = eventDiagnostics(eventB);

    // Positive control: a real digest, not the `unknown` sentinel, and equal to
    // an independently recomputed expectation.
    const expectedIdentity = expectedReleaseIdentity(path.join(a, '.whatsoup-release-manifest.json'));
    expect(expectedIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(diagA.desired_release_identity).toBe(expectedIdentity);
    expect(diagA.observed_release_identity).toBe(expectedIdentity);

    // The property #2385 C2 needs: different basenames, one identity.
    expect(diagB.desired_release_identity).toBe(diagA.desired_release_identity);
    expect(diagB.observed_release_identity).toBe(diagA.observed_release_identity);
    expect(diagA.drift_kind).toBe('none');
    expect(diagB.drift_kind).toBe('none');

    // Content-free: the typed fields name no path and no release directory.
    const identities = [
      diagA.desired_release_identity,
      diagA.observed_release_identity,
      diagB.desired_release_identity,
      diagB.observed_release_identity,
    ];
    for (const value of identities) {
      expect(value).not.toContain(path.sep);
      expect(value).not.toContain(FIXTURE_RELEASE_NAME_A);
      expect(value).not.toContain(FIXTURE_RELEASE_NAME_B);
      expect(value).not.toContain(tmpRoot);
    }
  });

  it('carries a bounded drift kind and a real desired identity on a drift alert', () => {
    const { a, b } = writeTwinReleases({ drift: true });
    expect(path.basename(a)).not.toBe(path.basename(b));

    const stateDirA = path.join(tmpRoot, 'state-a');
    const stateDirB = path.join(tmpRoot, 'state-b');
    const procA = runCli(['--release', a], { BOT_ERRORS_STATE_DIR: stateDirA });
    const procB = runCli(['--release', b], { BOT_ERRORS_STATE_DIR: stateDirB });
    expect(procA.status, procA.stderr).toBe(1);
    expect(procB.status, procB.stderr).toBe(1);

    const diagA = eventDiagnostics(outboxEvents(stateDirA)[0]);
    const diagB = eventDiagnostics(outboxEvents(stateDirB)[0]);

    expect(diagA.drift_kind).toBe(DRIFT_KIND_SINGLE);
    expect(diagB.drift_kind).toBe(DRIFT_KIND_SINGLE);
    const expectedIdentity = expectedReleaseIdentity(path.join(a, '.whatsoup-release-manifest.json'));
    expect(diagA.desired_release_identity).toBe(expectedIdentity);
    expect(diagB.desired_release_identity).toBe(expectedIdentity);
    // A drifted tree's real identity would need a re-walk this leaf does not do,
    // so observed stays the explicit `unknown` sentinel rather than a guess.
    expect(diagA.observed_release_identity).toBe('unknown');
    expect(diagB.observed_release_identity).toBe('unknown');
  });

  it('emits the path-free summary byte-exactly on both the clear and the alert', () => {
    const clean = writeTwinReleases();
    const cleanToken = expectedIdentityToken(path.join(clean.a, '.whatsoup-release-manifest.json'));
    const cleanStateDir = path.join(tmpRoot, 'state-clean');
    expect(runCli(['--release', clean.a, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: cleanStateDir }).status).toBe(0);
    expect(outboxEvents(cleanStateDir)[0].summary).toBe(pathFreeRecoveredSummary(cleanToken));

    // afterEach only removes the LAST tmpRoot, so the first tree is removed here
    // rather than left behind for the run.
    rmSync(tmpRoot, { recursive: true, force: true });
    const drifted = writeTwinReleases({ drift: true });
    const driftToken = expectedIdentityToken(path.join(drifted.b, '.whatsoup-release-manifest.json'));
    const driftStateDir = path.join(tmpRoot, 'state-drift');
    expect(runCli(['--release', drifted.b], { BOT_ERRORS_STATE_DIR: driftStateDir }).status).toBe(1);
    expect(outboxEvents(driftStateDir)[0].summary).toBe(pathFreeDetectedSummaryOneIssue(driftToken));
  });

  /**
   * #2385 L1b, the grouping property itself. The byte-exact test above pins one
   * host's text; this one pins that the text does not vary with the release
   * directory, which is what lets the dispatcher collapse two hosts into one
   * incident.
   */
  it('emits one path-free summary for two hosts whose release directories differ', () => {
    const { a, b } = writeTwinReleases({ drift: true });
    // Coverage assertion: equal summaries would prove nothing about the basename
    // if the two fixtures shared a directory name.
    expect(path.basename(a)).not.toBe(path.basename(b));

    const stateDirA = path.join(tmpRoot, 'state-a');
    const stateDirB = path.join(tmpRoot, 'state-b');
    const procA = runCli(['--release', a], { BOT_ERRORS_STATE_DIR: stateDirA });
    const procB = runCli(['--release', b], { BOT_ERRORS_STATE_DIR: stateDirB });
    expect(procA.status, procA.stderr).toBe(1);
    expect(procB.status, procB.stderr).toBe(1);

    const [eventA] = outboxEvents(stateDirA);
    const [eventB] = outboxEvents(stateDirB);
    const summaryA = String(eventA.summary);
    const summaryB = String(eventB.summary);

    // Coverage assertion, and it must come first: every `not.toContain` below
    // passes on an empty string or on the literal `undefined`, so the text is
    // pinned to a real value before anything is asserted absent from it.
    const token = expectedIdentityToken(path.join(a, '.whatsoup-release-manifest.json'));
    expect(summaryA).toBe(pathFreeDetectedSummaryOneIssue(token));
    // The property the dispatcher groups on: same release, two directory names,
    // one text. The identity token is part of that text, so it has to be equal
    // as well as present, otherwise it would re-split the group it was added to
    // discriminate.
    expect(summaryB).toBe(summaryA);
    expect(summaryA).toContain(` release ${token}`);

    for (const summary of [summaryA, summaryB]) {
      expect(summary).not.toContain(FIXTURE_RELEASE_NAME_A);
      expect(summary).not.toContain(FIXTURE_RELEASE_NAME_B);
      // No filesystem path segment of any kind, not merely these two fixtures.
      expect(summary).not.toContain(path.sep);
      expect(summary).not.toContain(tmpRoot);
    }

    // Negative control: taking the name out of the text left the typed fields
    // untouched. They are the only identity channel on the event, so a summary
    // that went path-free by dropping identity information altogether would
    // fail here.
    const diagA = eventDiagnostics(eventA);
    const diagB = eventDiagnostics(eventB);
    const expectedIdentity = expectedReleaseIdentity(path.join(a, '.whatsoup-release-manifest.json'));
    expect(expectedIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(diagA.drift_kind).toBe(DRIFT_KIND_SINGLE);
    expect(diagB.drift_kind).toBe(DRIFT_KIND_SINGLE);
    expect(diagA.desired_release_identity).toBe(expectedIdentity);
    expect(diagB.desired_release_identity).toBe(expectedIdentity);
    // A drifted tree's real identity would need a re-walk this leaf does not do,
    // so observed stays the explicit sentinel, unchanged from L1a.
    expect(diagA.observed_release_identity).toBe('unknown');
    expect(diagB.observed_release_identity).toBe('unknown');
  });

  /**
   * The other half of the grouping property. The test above proves one release
   * under two directory names collapses to one text; this one proves two
   * DIFFERENT releases do not collapse, which is what the identity token buys
   * back. The issue count is held equal on purpose, because the count is the
   * only other varying part of the text and would otherwise separate the two
   * summaries on its own and prove nothing about the token.
   */
  it('separates two different releases whose drift produces the same issue count', () => {
    const first = writeTwinReleases({ drift: true });
    const firstToken = expectedIdentityToken(path.join(first.a, '.whatsoup-release-manifest.json'));
    const firstStateDir = path.join(tmpRoot, 'state-first');
    const procFirst = runCli(['--release', first.a], { BOT_ERRORS_STATE_DIR: firstStateDir });
    expect(procFirst.status, procFirst.stderr).toBe(1);
    const [eventFirst] = outboxEvents(firstStateDir);
    const summaryFirst = String(eventFirst.summary);
    const countFirst = eventIssueCount(eventFirst);

    // afterEach only removes the LAST tmpRoot, so everything read from the first
    // tree is captured above, before the tree goes away.
    rmSync(tmpRoot, { recursive: true, force: true });

    // A different commit is a different release: the identity reads
    // `source.commit`, and it reads no path, so moving the tmp directory alone
    // would have produced the same identity twice.
    const second = writeTwinReleases({ drift: true, sourceCommit: FIXTURE_SOURCE_COMMIT_OTHER });
    const secondToken = expectedIdentityToken(path.join(second.a, '.whatsoup-release-manifest.json'));
    const secondStateDir = path.join(tmpRoot, 'state-second');
    const procSecond = runCli(['--release', second.a], { BOT_ERRORS_STATE_DIR: secondStateDir });
    expect(procSecond.status, procSecond.stderr).toBe(1);
    const [eventSecond] = outboxEvents(secondStateDir);
    const summarySecond = String(eventSecond.summary);

    // Coverage assertions before the inequality: two releases that shared an
    // identity, or drifts of unequal size, would make the difference below
    // prove something other than what this test claims.
    expect(firstToken).not.toBe(secondToken);
    expect(countFirst).toBe(eventIssueCount(eventSecond));
    expect(summaryFirst).toBe(pathFreeDetectedSummaryOneIssue(firstToken));
    expect(summarySecond).toBe(pathFreeDetectedSummaryOneIssue(secondToken));
    // The two expectations above already pin every byte, so this states the
    // consequence the dispatcher cares about rather than adding coverage.
    expect(summarySecond).not.toBe(summaryFirst);
  });

  /**
   * The token is a truncation of the typed field, not a second digest computed
   * on its own. If the two ever diverge, an operator correlating the incident
   * text against the event diagnostics is silently reading two different
   * releases, which is worse than carrying no token at all.
   */
  it('carries a token that is exactly the first eight hex of the typed desired identity', () => {
    const { a } = writeTwinReleases({ drift: true });
    const stateDir = path.join(tmpRoot, 'state-token-width');
    const proc = runCli(['--release', a], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(1);

    const [event] = outboxEvents(stateDir);
    const summary = String(event.summary);
    const identity = eventDiagnostics(event).desired_release_identity;
    expect(identity).toMatch(/^[0-9a-f]{64}$/);

    // Anchored at the end and width-bounded, so a longer slice, a shorter one or
    // a trailing path segment all fail here rather than being absorbed.
    const match = /^release drift detected \(1 issue\) release ([0-9a-f]{8})$/.exec(summary);
    expect(match, `summary did not match the pinned token shape: ${summary}`).not.toBeNull();
    expect(match![1]).toBe(identity.slice(0, RELEASE_IDENTITY_TOKEN_LENGTH));
  });
});

/**
 * Type-level checks on the drift-kind types. An annotation on a constant is
 * only an assignability check, which widening never breaks, so the two checks
 * below are a mutual-assignability conditional and a rejection probe instead.
 *
 * What they catch: adding or removing a member of the issue-kind union without
 * updating this list; retyping `DriftKindField` to `string`. What they do NOT
 * catch: free text after the first comma in a joined value, which the field
 * type cannot express (see its doc comment) and which the two-kind test below
 * asserts on the emitted value instead.
 */
type ExpectedDriftKinds =
  | 'release-missing'
  | 'manifest-missing'
  | 'manifest-release-path-mismatch'
  | 'file-missing'
  | 'file-type-drift'
  | 'file-sha256-drift'
  | 'extra-file'
  | 'required-output-missing'
  | 'launchd-working-directory-mismatch';

type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? ([Right] extends [Left] ? true : never)
  : never;

const DRIFT_KINDS_ARE_EXACTLY_EXPECTED: MutuallyAssignable<DriftKindMember, ExpectedDriftKinds> = true;

// A rejection probe, not an assignability check: if the field type is widened
// to `string` this assignment compiles, the directive goes unused, and the
// typecheck fails. It is permanent, so the expiry is a far date by convention.
// @ts-expect-error -- DriftKindField must reject a non-member; expires 2099-12-31
const DRIFT_KIND_FIELD_REJECTS_FREE_TEXT: DriftKindField = 'not-a-drift-kind';

const DRIFT_KIND_SINGLE: DriftKindField = 'file-sha256-drift';
const DRIFT_KIND_JOINED: DriftKindField = 'extra-file,file-sha256-drift';
const DRIFT_KIND_MANIFEST_MISSING: DriftKindField = 'manifest-missing';
const DRIFT_KIND_RELEASE_MISSING: DriftKindField = 'release-missing';
const DRIFT_KIND_NONE: DriftKindField = 'none';

describe('live release drift alert #2385: drift_kind set and order', () => {
  it('joins several kinds in ascending order rather than reporting only the first', () => {
    const { a } = writeTwinReleases({ drift: true });
    // A second, different kind: a file present in the release that the manifest
    // does not list. One drifted file alone cannot distinguish a set from its
    // first element, nor a sorted join from an unsorted one.
    writeFileSync(path.join(a, 'unmanifested-extra.txt'), 'extra\n', 'utf8');

    // Coverage assertion: the order the checker reports these kinds in is NOT
    // already alphabetical, so sorting is observable. Without this, dropping the
    // sort could pass by accident.
    const naturalOrder = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath: a,
      instance: 'release-bot',
      source: 'release-drift',
      emit: false,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
    }).issues.map((issue) => issue.kind);
    expect(new Set(naturalOrder).size).toBe(2);
    expect(naturalOrder).not.toEqual([...naturalOrder].sort());

    const stateDir = path.join(tmpRoot, 'state-two-kind');
    const proc = runCli(['--release', a], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(1);

    // Assertions on the EMITTED value, not on the expectation.
    const diagnostics = eventDiagnostics(outboxEvents(stateDir)[0]);
    const emittedMembers = String(diagnostics.drift_kind).split(',');
    expect(emittedMembers).toHaveLength(2);
    expect(emittedMembers).toEqual(['extra-file', 'file-sha256-drift']);
    expect(emittedMembers).toEqual([...new Set(naturalOrder)].sort());
    expect(diagnostics.drift_kind).toBe(DRIFT_KIND_JOINED);
  });
});

describe('live release drift alert #2385: identity is defined over the parsed manifest', () => {
  /**
   * Rewrite a release manifest in a form the schema parser normalises away:
   * `./`-prefixed file paths, uppercase hashes, and reversed file order. The
   * release still verifies, because the drift checker reads the same parsed
   * manifest.
   */
  function denormaliseManifest(releasePath: string): void {
    const manifestPath = path.join(releasePath, '.whatsoup-release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ path: string; sha256: string; sizeBytes: number }>;
    };
    manifest.files = [...manifest.files]
      .reverse()
      .map((file) => ({ ...file, path: `./${file.path}`, sha256: file.sha256.toUpperCase() }));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  it('gives a denormalised manifest the same identity as its normalised twin', () => {
    const { a, b } = writeTwinReleases();
    denormaliseManifest(b);
    // Coverage assertion: the two manifest FILES really differ on disk, so an
    // identity that hashed raw bytes or raw field values could not match.
    const rawA = readFileSync(path.join(a, '.whatsoup-release-manifest.json'), 'utf8');
    const rawB = readFileSync(path.join(b, '.whatsoup-release-manifest.json'), 'utf8');
    expect(rawB).not.toBe(rawA);
    expect(rawB).toContain('./package.json');

    const stateDirA = path.join(tmpRoot, 'state-a');
    const stateDirB = path.join(tmpRoot, 'state-b');
    expect(runCli(['--release', a, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDirA }).status).toBe(0);
    expect(runCli(['--release', b, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDirB }).status).toBe(0);

    const diagA = eventDiagnostics(outboxEvents(stateDirA)[0]);
    const diagB = eventDiagnostics(outboxEvents(stateDirB)[0]);
    expect(diagA.desired_release_identity).toMatch(/^[0-9a-f]{64}$/);
    expect(diagB.desired_release_identity).toBe(diagA.desired_release_identity);
  });

  it('yields the unknown sentinel for manifest text the schema parser rejects', () => {
    const { a } = writeTwinReleases();
    const validText = readFileSync(path.join(a, '.whatsoup-release-manifest.json'), 'utf8');
    // Positive control: valid text really does produce a digest here, so the
    // sentinel assertions below cannot pass because the function always fails.
    expect(releaseIdentityFromManifestText(validText)).toMatch(/^[0-9a-f]{64}$/);

    // A well-formed JSON object the schema parser rejects. Canonicalising
    // whatever fields happen to be present would hand it a valid-looking digest
    // that every other malformed manifest would share.
    expect(releaseIdentityFromManifestText('{"unrelated":true}')).toBe('unknown');
    expect(releaseIdentityFromManifestText('{')).toBe('unknown');
    expect(releaseIdentityFromManifestText('[]')).toBe('unknown');
  });

  it('emits no event at all when the on-disk manifest is unparseable', () => {
    const { a } = writeTwinReleases();
    writeFileSync(path.join(a, '.whatsoup-release-manifest.json'), '{"unrelated":true}\n', 'utf8');

    const stateDir = path.join(tmpRoot, 'state-invalid');
    const proc = runCli(['--release', a], { BOT_ERRORS_STATE_DIR: stateDir });

    // The drift checker parses the manifest before this script sees it, so an
    // unparseable manifest is a checker_failed outcome with no event. That is
    // why the sentinel above is pinned on the function and not on a diagnostic:
    // on disk the branch is only reachable if the manifest is replaced between
    // the checker's read and this script's read.
    expect(proc.status, proc.stderr).not.toBe(0);
    expect(parseRecordLine(proc.stdout)).toMatchObject({ outcome: 'checker_failed' });
    expect(existsSync(path.join(stateDir, 'outbox'))).toBe(false);
  });
});

describe('live release drift alert #2385: fail-open branches stay pinned', () => {
  it('reports manifest-missing with both identities unknown', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
    const releasePath = path.join(tmpRoot, 'releases', 'WhatSoup-release-nomanifest');
    mkdirSync(releasePath, { recursive: true });

    const stateDir = path.join(tmpRoot, 'state-no-manifest');
    const proc = runCli(['--release', releasePath], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(1);

    const diagnostics = eventDiagnostics(outboxEvents(stateDir)[0]);
    // The fail-open decision point: no manifest means no attestable identity,
    // and the event must say so rather than omit the fields or invent a digest.
    expect(diagnostics.drift_kind).toBe(DRIFT_KIND_MANIFEST_MISSING);
    expect(diagnostics.desired_release_identity).toBe('unknown');
    expect(diagnostics.observed_release_identity).toBe('unknown');
  });

  /**
   * The documented coverage limit of the identity token, pinned as behaviour so
   * a later change cannot quietly start emitting a digest of the sentinel. With
   * no manifest there is nothing to attest, so the token is the literal
   * sentinel and every such event across every host shares one summary. The
   * token restores per-release discrimination for every kind EXCEPT the ones
   * that cannot read a manifest, and this is that exception.
   */
  it('puts the unknown sentinel in the summary, not a digest, when the manifest cannot be read', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
    const releaseName = 'WhatSoup-release-nomanifest';
    const releasePath = path.join(tmpRoot, 'releases', releaseName);
    mkdirSync(releasePath, { recursive: true });

    const stateDir = path.join(tmpRoot, 'state-no-manifest-summary');
    const proc = runCli(['--release', releasePath], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(1);

    const [event] = outboxEvents(stateDir);
    const summary = String(event.summary);
    // Equality first: the absence assertions below all pass on an empty string.
    expect(summary).toBe(pathFreeDetectedSummaryOneIssue(UNKNOWN_IDENTITY_TOKEN));
    expect(eventDiagnostics(event).desired_release_identity).toBe(UNKNOWN_IDENTITY_TOKEN);
    // The sentinel branch is still bound by the path-free rule of this leaf.
    expect(summary).not.toContain(releaseName);
    expect(summary).not.toContain(path.sep);
    expect(summary).not.toContain(tmpRoot);
  });

  /**
   * The other half of the documented coverage limit, and the half that is easy
   * to get wrong from the kind name alone. `release-missing` reads a manifest:
   * the issue is pushed inside `collectReleaseSnapshotDrift`, which runs only
   * after the report has read and parsed the manifest, so the identity is a real
   * 64-hex digest and the token discriminates between releases exactly as it
   * does for a content drift. Without this test the comment's claim that the
   * sentinel covers one kind rather than two rests on reading alone.
   *
   * The kind is only reachable through the documented `--manifest` override.
   * With the default path the manifest lives inside the release directory, so a
   * missing release directory makes the manifest missing too and the report
   * returns `manifest-missing` before this branch is ever considered.
   *
   * The manifest is moved out of the release before the release is moved aside,
   * so `manifest.release.path` still names the now-absent directory. An override
   * naming a manifest built for some other path would add a
   * `manifest-release-path-mismatch` issue and change the count the summary
   * carries, which is why the record's issue-kind map is pinned exactly rather
   * than the count being assumed from the fixture.
   */
  it('carries a real per-release token for release-missing rather than the sentinel', () => {
    const { a } = writeTwinReleases();
    const archivedManifest = path.join(tmpRoot, 'archived-manifest.json');
    renameSync(path.join(a, '.whatsoup-release-manifest.json'), archivedManifest);
    renameSync(a, path.join(tmpRoot, 'release-moved-aside'));

    const stateDir = path.join(tmpRoot, 'state-release-missing');
    const proc = runCli(['--release', a, '--manifest', archivedManifest], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(1);
    expect(parseRecordLine(proc.stdout).issueKinds).toEqual({ 'release-missing': 1 });

    const [event] = outboxEvents(stateDir);
    // The oracle asserts the full 64-hex shape before truncating, so a sentinel
    // identity cannot make the summary expectation below pass vacuously.
    const token = expectedIdentityToken(archivedManifest);
    expect(String(event.summary)).toBe(pathFreeDetectedSummaryOneIssue(token));
    expect(eventDiagnostics(event).drift_kind).toBe(DRIFT_KIND_RELEASE_MISSING);
    expect(eventDiagnostics(event).desired_release_identity).toBe(expectedReleaseIdentity(archivedManifest));
  });

  it('carries the typed fields under --launchd-plist, the mode the shipped job uses', () => {
    const { a } = writeTwinReleases();
    const plistPath = writeLaunchdPlist(a);
    const stateDir = path.join(tmpRoot, 'state-plist');

    // The scheduled job passes no --manifest, so the manifest is resolved from
    // the release the plist selects.
    const proc = runCli(['--launchd-plist', plistPath, '--clear-on-ok'], { BOT_ERRORS_STATE_DIR: stateDir });
    expect(proc.status, proc.stderr).toBe(0);

    const diagnostics = eventDiagnostics(outboxEvents(stateDir)[0]);
    const expectedIdentity = expectedReleaseIdentity(path.join(a, '.whatsoup-release-manifest.json'));
    expect(diagnostics.drift_kind).toBe(DRIFT_KIND_NONE);
    expect(diagnostics.desired_release_identity).toBe(expectedIdentity);
    expect(diagnostics.observed_release_identity).toBe(expectedIdentity);
  });
});

describe('live release drift alert #2385: an identity failure never costs the alert', () => {
  it('degrades to the sentinel and names the error class instead of propagating', () => {
    // The identity code re-throws anything that is not a parse or schema
    // failure. Without the boundary that error would escape checkLiveReleaseDrift
    // and the drift alert would never be enqueued.
    for (const thrown of [new TypeError('boom'), new RangeError('boom')]) {
      const contained = containedReleaseIdentity(() => {
        throw thrown;
      });
      expect(contained.identity).toBe('unknown');
      expect(contained.errorClass).toBe(thrown.constructor.name);
      // The class name only: a message can carry a path or file content.
      expect(contained.errorClass).not.toContain('boom');
    }

    // Positive control: the boundary is transparent when nothing throws, so the
    // assertions above cannot pass because it always reports failure.
    const computed = 'a'.repeat(64);
    expect(containedReleaseIdentity(() => computed)).toEqual({ identity: computed, errorClass: null });
  });

  it('still emits the drift alert when the identity computation throws', () => {
    const { a } = writeTwinReleases({ drift: true });
    const stateDir = path.join(tmpRoot, 'state-identity-throws');
    process.env.BOT_ERRORS_STATE_DIR = stateDir;

    // Poison the identity path only. The drift report calls the parser through
    // release-snapshot-plan's own internal binding, which the module mock does
    // not intercept, so the report still succeeds on the real parser and the
    // only intercepted call is this script's identity parse.
    parseControl.calls = 0;
    parseControl.failFromCall = 1;
    let result;
    try {
      result = checkLiveReleaseDrift({
        repoRoot: process.cwd(),
        releasePath: a,
        instance: 'release-bot',
        source: 'release-drift',
        emit: true,
        emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
        python: 'python3',
        clearOnOk: false,
      });
    } finally {
      parseControl.failFromCall = 0;
    }

    // Coverage assertion: the poisoned call really fired, so the test cannot
    // pass by never reaching the identity path.
    expect(parseControl.calls, 'the identity parse must have been reached').toBe(1);
    expect(result.alert).toMatchObject({ required: true, attempted: true, kind: 'alert', status: 0 });

    const diagnostics = eventDiagnostics(outboxEvents(stateDir)[0]);
    // The alert survives, the drift kind is intact, the identity degrades.
    expect(diagnostics.drift_kind).toBe(DRIFT_KIND_SINGLE);
    expect(diagnostics.desired_release_identity).toBe('unknown');
    expect(diagnostics.observed_release_identity).toBe('unknown');
    expect(diagnostics.release_identity_error).toBe('TypeError');
    expect(diagnostics.release_identity_error).not.toContain('poisoned');
  });
});
