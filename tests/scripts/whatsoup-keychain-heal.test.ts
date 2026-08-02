// tests/scripts/whatsoup-keychain-heal.test.ts
//
// Black-box tests for deploy/scripts/whatsoup-keychain-heal.sh.
// Spawns the script with fake `curl` and `launchctl` injected on PATH so every
// branch is exercised deterministically without touching a real host or service.
//
// The fakes coordinate through env-pointed state files:
//   STATE_FILE   — health state the fake curl reports (healthy|degraded|unreachable|parse|fields)
//   KICK_COUNT   — fake launchctl increments this on each kickstart
//   KICK_LOG     — fake launchctl appends its argv here
//   RECOVER_AFTER— when set, fake launchctl flips STATE_FILE to "healthy" once
//                  KICK_COUNT reaches it (simulates a kickstart that recovers the model)
//   KICK_FAIL    — when set, fake launchctl exits non-zero (kickstart failure branch)
//
// No setTimeout/sleep in the test — the script is invoked with --settle 0.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'deploy/scripts/whatsoup-keychain-heal.sh');

const tmp = trackTmpDirs('keychain-heal');

function makeTmpDir(): string {
  return tmp.make('');
}

const FAKE_CURL = [
  '#!/usr/bin/env bash',
  '# fake curl: report health JSON based on $STATE_FILE',
  'state="$(cat "$STATE_FILE" 2>/dev/null || echo degraded)"',
  'case "$state" in',
  "  healthy)     echo '{\"status\":\"healthy\",\"turn_capability\":{\"model_usable\":true}}' ;;",
  "  stale)       echo '{\"status\":\"healthy\",\"turn_capability\":{\"model_usable\":true,\"model_usable_stale\":true}}' ;;",
  "  degraded)    echo '{\"status\":\"degraded\",\"turn_capability\":{\"model_usable\":false}}' ;;",
  '  unreachable) exit 7 ;;',
  "  parse)       echo 'not-json{' ;;",
  "  fields)      echo '{\"status\":\"degraded\"}' ;;",
  'esac',
  'exit 0',
  '',
].join('\n');

const FAKE_LAUNCHCTL = [
  '#!/usr/bin/env bash',
  '# fake launchctl: record kickstart, optionally flip state to healthy or fail',
  'echo "$@" >> "$KICK_LOG"',
  'count=$(( $(cat "$KICK_COUNT" 2>/dev/null || echo 0) + 1 ))',
  'echo "$count" > "$KICK_COUNT"',
  'if [[ -n "${KICK_FAIL:-}" ]]; then exit 3; fi',
  'if [[ -n "${RECOVER_AFTER:-}" && "$count" -ge "$RECOVER_AFTER" ]]; then echo healthy > "$STATE_FILE"; fi',
  'exit 0',
  '',
].join('\n');

interface Harness {
  binDir: string;
  stateFile: string;
  kickCount: string;
  kickLog: string;
}

function makeHarness(initialState: string): Harness {
  const root = makeTmpDir();
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const curlPath = join(binDir, 'curl');
  const launchctlPath = join(binDir, 'launchctl');
  writeFileSync(curlPath, FAKE_CURL, 'utf8');
  writeFileSync(launchctlPath, FAKE_LAUNCHCTL, 'utf8');
  chmodSync(curlPath, 0o755);
  chmodSync(launchctlPath, 0o755);

  const stateFile = join(root, 'state');
  const kickCount = join(root, 'kickcount');
  const kickLog = join(root, 'kicklog');
  writeFileSync(stateFile, initialState, 'utf8');
  return { binDir, stateFile, kickCount, kickLog };
}

function runHeal(
  h: Harness,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    // spawnSync blocks the event loop, so vitest's describe/it timeout cannot
    // interrupt a hung child — bound the child itself and hard-kill on overrun.
    timeout: 15_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PATH: `${h.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      STATE_FILE: h.stateFile,
      KICK_COUNT: h.kickCount,
      KICK_LOG: h.kickLog,
      ...extraEnv,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function kickstartCount(h: Harness): number {
  if (!existsSync(h.kickCount)) return 0;
  return Number.parseInt(readFileSync(h.kickCount, 'utf8').trim() || '0', 10);
}

const BASE_ARGS = ['--label', 'com.whatsoup.x-bot', '--port', '9090', '--uid', '501', '--settle', '0'];

// Each case spawns bash + a fake curl + python3 several times; give the suite
// generous headroom so a cold first spawn never trips the 10s default.
describe('whatsoup-keychain-heal.sh', { timeout: 30_000 }, () => {
  it('exits 0 with no kickstart when the bot is already healthy', () => {
    const h = makeHarness('healthy');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS);
    expect(exitCode, 'already-healthy should exit 0').toBe(0);
    expect(kickstartCount(h), 'must not restart a healthy bot').toBe(0);
    expect(stderr).toMatch(/already healthy/i);
  });

  it('treats a stale-green bot (model_usable=true but model_usable_stale=true) as degraded, not healthy (F1)', () => {
    // The #1392 stale-green blind spot: an aged "usable" probe must not read as
    // healthy, or the self-heal monitor takes no action on stale model usability.
    const h = makeHarness('stale');
    const { exitCode, stderr } = runHeal(h, [...BASE_ARGS, '--max-kickstarts', '1']);
    expect(exitCode, 'stale-green must not be accepted as already-healthy').toBe(1);
    expect(kickstartCount(h), 'stale-green should trigger a remediation kickstart').toBeGreaterThanOrEqual(1);
    expect(stderr).not.toMatch(/already healthy/i);
    expect(stderr).toMatch(/still degraded/i);
  });

  it('kickstarts once and exits 0 when a degraded bot recovers', () => {
    const h = makeHarness('degraded');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS, { RECOVER_AFTER: '1' });
    expect(exitCode, 'recovered should exit 0').toBe(0);
    expect(kickstartCount(h), 'should kickstart exactly once to recover').toBe(1);
    expect(stderr).toMatch(/recovered after 1 kickstart/i);
    // confirm the kickstart targeted the right GUI domain + label
    expect(readFileSync(h.kickLog, 'utf8')).toContain('gui/501/com.whatsoup.x-bot');
  });

  it('substitutes --uid into the kickstart target', () => {
    // Proves the script interpolates $uid rather than hardcoding 501.
    const h = makeHarness('degraded');
    const { exitCode } = runHeal(
      h,
      ['--label', 'com.whatsoup.x-bot', '--port', '9090', '--uid', '502', '--settle', '0'],
      { RECOVER_AFTER: '1' },
    );
    expect(exitCode, 'recovered should exit 0').toBe(0);
    expect(readFileSync(h.kickLog, 'utf8')).toContain('gui/502/com.whatsoup.x-bot');
  });

  it('exhausts bounded kickstarts then exits 1 when degradation persists', () => {
    const h = makeHarness('degraded');
    const { exitCode, stderr } = runHeal(h, [...BASE_ARGS, '--max-kickstarts', '2']);
    expect(exitCode, 'persistent degradation should exit 1').toBe(1);
    expect(kickstartCount(h), 'should kickstart exactly max-kickstarts times').toBe(2);
    expect(stderr).toMatch(/still degraded after 2 kickstart/i);
    expect(stderr).toMatch(/escalate/i);
  });

  it('fails closed (exit 2) when /health is unreachable', () => {
    const h = makeHarness('unreachable');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS);
    expect(exitCode, 'unreachable should fail closed with exit 2').toBe(2);
    expect(kickstartCount(h), 'must not kickstart when unreachable').toBe(0);
    expect(stderr).toMatch(/unreachable/i);
  });

  it('fails closed (exit 2) when /health body is not JSON', () => {
    const h = makeHarness('parse');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS);
    expect(exitCode, 'unparseable body should exit 2').toBe(2);
    expect(kickstartCount(h), 'must not kickstart on parse failure').toBe(0);
    expect(stderr).toMatch(/parseable JSON/i);
  });

  it('exits 3 when the health body is missing required fields', () => {
    const h = makeHarness('fields');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS);
    expect(exitCode, 'missing fields should exit 3').toBe(3);
    expect(kickstartCount(h), 'must not kickstart on missing fields').toBe(0);
    expect(stderr).toMatch(/missing status or/i);
  });

  it('fails closed (exit 2) when the kickstart command itself fails', () => {
    const h = makeHarness('degraded');
    const { exitCode, stderr } = runHeal(h, BASE_ARGS, { KICK_FAIL: '1' });
    expect(exitCode, 'kickstart failure should exit 2').toBe(2);
    expect(kickstartCount(h), 'should attempt exactly one kickstart before failing closed').toBe(1);
    expect(stderr).toMatch(/kickstart failed/i);
  });

  it('exits 2 on bad arguments (missing --label)', () => {
    const h = makeHarness('healthy');
    const { exitCode, stderr } = runHeal(h, ['--port', '9090']);
    expect(exitCode, 'missing --label should exit 2').toBe(2);
    expect(stderr).toMatch(/missing --label/i);
  });
});
