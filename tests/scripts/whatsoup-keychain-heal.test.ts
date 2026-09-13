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
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'deploy/scripts/whatsoup-keychain-heal.sh');
const TOKEN = 'a'.repeat(64);
const CURRENT_UID = String(process.getuid!());

const tmp = trackTmpDirs('keychain-heal');

function makeTmpDir(): string {
  return tmp.make('');
}

// Exercise the real private-file reader. The HTTP fake grants diagnostic
// evidence only for the fixture token delivered through curl config stdin.
const FAKE_CURL = `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
config = sys.stdin.read() if '--config' in args and args[args.index('--config') + 1] == '-' else ''
authorized = ('header = "Authorization: Bearer ' + 'a' * 64 + '"') in config.splitlines()
pathlib.Path(os.environ['CURL_LOG']).write_text(json.dumps({'argv': args, 'env': dict(os.environ), 'authorized': authorized}))
state = pathlib.Path(os.environ['STATE_FILE']).read_text()
payload = {'status': 'healthy', 'instance': {'name': 'x-bot'}, 'whatsapp': {}, 'turn_capability': {'model_usable': True, 'model_usable_stale': False}}
if state in ('degraded', 'stale'):
    payload['status'] = 'degraded' if state == 'degraded' else 'healthy'
    payload['turn_capability'] = {'model_usable': state == 'stale', 'model_usable_stale': state == 'stale'}
elif state == 'fields':
    del payload['turn_capability']
elif state == 'freshness':
    payload.update(json.loads(os.environ['FRESHNESS_BODY']))
elif state == 'raw':
    payload = json.loads(os.environ['HEALTH_BODY'])
if not authorized:
    payload = {'schema_version': 'health.public.v1', 'status': 'healthy'}
body = 'not-json{' if state == 'parse' and authorized else json.dumps(payload)
print(body)
if '--write-out' in args or '-w' in args:
    print(os.environ.get('HTTP_STATUS', '503' if state == 'degraded' else '200'))
sys.exit(7 if state == 'unreachable' else 0)
`;

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
  root: string;
  binDir: string;
  stateFile: string;
  kickCount: string;
  kickLog: string;
  curlLog: string;
  tokenPath: string;
  scriptPath?: string;
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
  const curlLog = join(root, 'curllog');
  const instanceDir = join(root, '.config/whatsoup/instances/x-bot');
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(instanceDir, 'tokens.env');
  writeFileSync(tokenPath, `WHATSOUP_HEALTH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(stateFile, initialState, 'utf8');
  return { root, binDir, stateFile, kickCount, kickLog, curlLog, tokenPath };
}

function runHeal(
  h: Harness,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  trace = false,
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [...(trace ? ['-x'] : []), h.scriptPath ?? SCRIPT, ...args], {
    cwd: h.root,
    encoding: 'utf8',
    // spawnSync blocks the event loop, so vitest's describe/it timeout cannot
    // interrupt a hung child — bound the child itself and hard-kill on overrun.
    timeout: 15_000,
    killSignal: 'SIGKILL',
    env: {
      PATH: `${h.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: h.root,
      TMPDIR: h.root,
      XDG_CONFIG_HOME: join(h.root, '.config'),
      WHATSOUP_NODE: process.execPath,
      PYTHONDONTWRITEBYTECODE: '1',
      STATE_FILE: h.stateFile,
      KICK_COUNT: h.kickCount,
      KICK_LOG: h.kickLog,
      CURL_LOG: h.curlLog,
      ...extraEnv,
    },
  });
  if (result.error) throw result.error;
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

const BASE_ARGS = ['--label', 'com.whatsoup.x-bot', '--port', '9090', '--uid', CURRENT_UID, '--settle', '0'];

// Each case spawns bash + a fake curl + python3 several times; give the suite
// generous headroom so a cold first spawn never trips the 10s default.
describe('whatsoup-keychain-heal.sh', { timeout: 30_000 }, () => {
  it('authenticates over stdin without exposing the token in argv, environment or trace output', () => {
    const h = makeHarness('healthy');
    const result = runHeal(h, BASE_ARGS, { health_token: 'ambient-placeholder' }, true);
    expect(result.exitCode).toBe(0);
    const request = JSON.parse(readFileSync(h.curlLog, 'utf8'));
    expect(request.authorized).toBe(true);
    expect(request.argv).toContain('http://127.0.0.1:9090/health');
    expect(request.argv).toContain('--config');
    expect(request.argv[0]).toBe('-q');
    expect(request.argv).toContain('--noproxy');
    expect(request.env.health_token).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain(TOKEN);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it.each(['missing', 'incompatible'])('refuses %s Node before HTTP access', (scenario) => {
    const h = makeHarness('degraded');
    const nodePath = join(h.binDir, 'unsupported-node');
    if (scenario === 'incompatible') {
      writeFileSync(nodePath, '#!/usr/bin/env bash\nprintf "26\\n"\n', { mode: 0o700 });
    }
    const result = runHeal(h, BASE_ARGS, { WHATSOUP_NODE: nodePath });
    expect(result.exitCode).toBe(2);
    expect(kickstartCount(h)).toBe(0);
    expect(existsSync(h.curlLog)).toBe(false);
  });

  it.each(['resolver', 'reader'])('bounds a stalled %s without a health request or kickstart', (stage) => {
    const h = makeHarness('degraded');
    const nodePath = join(h.binDir, 'stalled-node');
    writeFileSync(nodePath, [
      '#!/usr/bin/env bash',
      'if [[ "$STALL_STAGE" == resolver || "$1" == --experimental-strip-types ]]; then exec sleep 10; fi',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'), { mode: 0o700 });
    const started = performance.now();
    const result = runHeal(h, [...BASE_ARGS, '--health-timeout', '1'], {
      WHATSOUP_NODE: nodePath, REAL_NODE: process.execPath, STALL_STAGE: stage,
    });
    expect(result.exitCode).toBe(2);
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(kickstartCount(h)).toBe(0);
    expect(existsSync(h.curlLog)).toBe(false);
  });

  it('refuses an unbounded zero timeout before HTTP access', () => {
    const h = makeHarness('degraded');
    const result = runHeal(h, [...BASE_ARGS, '--health-timeout', '0']);
    expect(result.exitCode).toBe(2);
    expect(kickstartCount(h)).toBe(0);
    expect(existsSync(h.curlLog)).toBe(false);
  });

  it.each(['other.x-bot', 'com.whatsoup../x-bot', 'com.whatsoup.X-bot', `com.whatsoup.${'a'.repeat(31)}`])(
    'refuses noncanonical instance label %s before token or HTTP access', (label) => {
      const h = makeHarness('healthy');
      const result = runHeal(h, [...BASE_ARGS, '--label', label]);
      expect(result.exitCode).toBe(2);
      expect(kickstartCount(h)).toBe(0);
      expect(existsSync(h.curlLog)).toBe(false);
    },
  );

  it.each(['missing', 'bad-mode', 'symlink', 'directory-symlink', 'duplicate', 'malformed', 'bad-directory'])(
    'refuses an unsafe or unavailable token file: %s', (scenario) => {
      const h = makeHarness('degraded');
      if (scenario === 'missing' || scenario === 'symlink') {
        renameSync(h.tokenPath, `${h.tokenPath}.saved`);
        if (scenario === 'symlink') symlinkSync(`${h.tokenPath}.saved`, h.tokenPath);
      }
      if (scenario === 'bad-mode') chmodSync(h.tokenPath, 0o644);
      if (scenario === 'bad-directory') chmodSync(dirname(h.tokenPath), 0o770);
      if (scenario === 'directory-symlink') {
        renameSync(dirname(h.tokenPath), `${dirname(h.tokenPath)}.saved`);
        symlinkSync(`${dirname(h.tokenPath)}.saved`, dirname(h.tokenPath));
      }
      if (scenario === 'duplicate') writeFileSync(h.tokenPath, `WHATSOUP_HEALTH_TOKEN=${TOKEN}\nWHATSOUP_HEALTH_TOKEN=${TOKEN}\n`);
      if (scenario === 'malformed') writeFileSync(h.tokenPath, 'WHATSOUP_HEALTH_TOKEN=invalid\n');
      const result = runHeal(h, BASE_ARGS);
      expect(result.exitCode).toBe(2);
      expect(kickstartCount(h)).toBe(0);
      expect(existsSync(h.curlLog)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
    },
  );

  it('refuses a stale canonical token when the server returns a public envelope', () => {
    const h = makeHarness('degraded');
    writeFileSync(h.tokenPath, `WHATSOUP_HEALTH_TOKEN=${'b'.repeat(64)}\n`);
    const result = runHeal(h, BASE_ARGS);
    expect(result.exitCode).toBe(2);
    expect(kickstartCount(h)).toBe(0);
    expect(JSON.parse(readFileSync(h.curlLog, 'utf8')).authorized).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('b'.repeat(64));
    expect(result.stderr).not.toMatch(/already healthy|recovered after|kickstart \d|escalate/i);
  });

  it.each(['default-home', 'explicit-xdg'])('resolves the canonical token using %s from another cwd', (mode) => {
    const h = makeHarness('healthy');
    const config = join(h.root, 'custom-config');
    if (mode === 'explicit-xdg') renameSync(join(h.root, '.config'), config);
    const result = runHeal(h, BASE_ARGS, { XDG_CONFIG_HOME: mode === 'explicit-xdg' ? config : undefined });
    expect(result.exitCode).toBe(0);
    expect(kickstartCount(h)).toBe(0);
    expect(JSON.parse(readFileSync(h.curlLog, 'utf8')).authorized).toBe(true);
  });

  it.each(['complete', 'missing-helper', 'missing-reader-module', 'missing-zod'])(
    'resolves the copied release dependency closure: %s', (scenario) => {
      const h = makeHarness('healthy');
      const release = join(h.root, 'release');
      const paths = [
        '.nvmrc', 'package.json', 'deploy/scripts/whatsoup-keychain-heal.sh',
        'deploy/lib/resolve-node.sh', 'deploy/lib/bounded-exec.sh',
        'deploy/lib/read-private-health-token.mjs', 'src/fleet/health-token-file.ts',
        'deploy/scripts/lib/health_reader.py', 'deploy/scripts/lib/classify_health.py',
      ];
      for (const relative of paths) {
        if (scenario === 'missing-helper' && relative === 'deploy/lib/read-private-health-token.mjs') continue;
        if (scenario === 'missing-reader-module' && relative === 'src/fleet/health-token-file.ts') continue;
        const destination = join(release, relative);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(join(REPO_ROOT, relative)));
      }
      if (scenario !== 'missing-zod') symlinkSync(join(REPO_ROOT, 'node_modules'), join(release, 'node_modules'));
      h.scriptPath = join(release, 'deploy/scripts/whatsoup-keychain-heal.sh');
      const result = runHeal(h, BASE_ARGS);
      expect(result.exitCode).toBe(scenario === 'complete' ? 0 : 2);
      expect(kickstartCount(h)).toBe(0);
      expect(existsSync(h.curlLog)).toBe(scenario === 'complete');
    },
  );

  it.each(['401', '403', '500'])('refuses HTTP %s even with a diagnostic-shaped degraded body', (status) => {
    const h = makeHarness('degraded');
    const result = runHeal(h, BASE_ARGS, { HTTP_STATUS: status });
    expect(result.exitCode).toBe(2);
    expect(kickstartCount(h)).toBe(0);
  });

  it.each([
    { name: 'public', body: { schema_version: 'health.public.v1', status: 'healthy' }, code: 2 },
    { name: 'unobserved', body: { status: 'degraded' }, code: 2 },
    { name: 'wrong instance', body: { status: 'degraded', whatsapp: {}, instance: { name: 'other-bot' }, turn_capability: { model_usable: false, model_usable_stale: false } }, code: 3 },
    { name: 'missing instance', body: { status: 'degraded', whatsapp: {}, turn_capability: { model_usable: false, model_usable_stale: false } }, code: 3 },
  ])('refuses $name evidence without a kickstart', ({ body, code }) => {
    const h = makeHarness('raw');
    const result = runHeal(h, BASE_ARGS, { HEALTH_BODY: JSON.stringify(body) });
    expect(result.exitCode).toBe(code);
    expect(kickstartCount(h)).toBe(0);
  });

  it('classifies authenticated HTTP 503 degradation with max-kickstarts 0 without action', () => {
    const h = makeHarness('degraded');
    const result = runHeal(h, [...BASE_ARGS, '--max-kickstarts', '0']);
    expect(result.exitCode).toBe(1);
    expect(kickstartCount(h)).toBe(0);
    expect(JSON.parse(readFileSync(h.curlLog, 'utf8')).authorized).toBe(true);
  });

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
    expect(readFileSync(h.kickLog, 'utf8')).toContain(`gui/${CURRENT_UID}/com.whatsoup.x-bot`);
  });

  it('refuses a different --uid before probing or kickstarting', () => {
    const h = makeHarness('degraded');
    const { exitCode } = runHeal(
      h,
      [...BASE_ARGS, '--uid', String(Number(CURRENT_UID) + 1)],
      { RECOVER_AFTER: '1' },
    );
    expect(exitCode).toBe(2);
    expect(kickstartCount(h)).toBe(0);
    expect(existsSync(h.curlLog)).toBe(false);
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

  for (const status of ['healthy', 'degraded']) {
    it.each([
      { name: 'missing', value: undefined },
      { name: 'null', value: null },
      { name: 'string', value: 'false' },
      { name: 'zero', value: 0 },
      { name: 'one', value: 1 },
      { name: 'object', value: {} },
      { name: 'array', value: [] },
    ])(
      `refuses ${status} with $name freshness without kickstart`,
      ({ value: stale }) => {
        const h = makeHarness('freshness');
        const { exitCode, stderr } = runHeal(h, BASE_ARGS, {
          FRESHNESS_BODY: JSON.stringify({
            status,
            turn_capability: { model_usable: true, model_usable_stale: stale },
          }),
        });
        expect(exitCode, 'unobserved freshness must use the fields exit').toBe(3);
        expect(kickstartCount(h), 'unknown evidence must never authorize kickstart').toBe(0);
        expect(stderr).not.toMatch(/already healthy|recovered after|kickstart \d/i);
      },
    );
  }

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
