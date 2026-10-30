import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { writeKeychainFixture } from './keychain-security-preload-fixture.ts';

const tmp = trackTmpDirs('');

const PROTECTED_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'ZAI_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'ZHIPU_API_KEY',
  'PINECONE_API_KEY',
  'ELEVENLABS_API_KEY',
  'WHATSOUP_HEALTH_TOKEN',
  'MS365_AGENT365_API_KEY',
] as const;

// Ported from the credential-hardening series (2bde84ace) and ADAPTED:
// the original asserted the launcher performs NO credential resolution at all.
// Main has since grown a deliberate post-scrub resolution architecture the
// fleet depends on (instance-scoped health-token file/keyring flow, chat API
// keys), so the enforced boundary here is ORDERING, not absence: inherited
// environment values are scrubbed before the first subprocess and before any
// resolution, making the launcher's own keyring/file resolution the single
// supplier of these variables.
describe('deploy/whatsoup credential environment boundary', () => {
  const source = readFileSync('deploy/whatsoup', 'utf8');
  const scrub = `unset ${PROTECTED_ENV_NAMES.join(' ')}`;
  const scrubIndex = source.indexOf(scrub);

  it('scrubs inherited credential variables before the first subprocess', () => {
    const firstSubprocessIndex = source.indexOf('$(');

    expect(scrubIndex).toBeGreaterThan(-1);
    expect(firstSubprocessIndex).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstSubprocessIndex);
  });

  it('covers every mapped credential name plus supported Google aliases', () => {
    const expected = new Set([
      ...Object.values(SERVICE_ENV_MAP),
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
      'MS365_AGENT365_API_KEY',
    ]);

    expect(new Set(PROTECTED_ENV_NAMES)).toEqual(expected);
  });

  it('scrubs before any deliberate credential resolution, so inherited values cannot shadow it', () => {
    const firstKeyringCall = source.indexOf('$(keyring_lookup');
    const firstHealthTokenRead = source.indexOf('whatsoup_read_private_health_token');

    expect(firstKeyringCall).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstKeyringCall);
    expect(firstHealthTokenRead).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstHealthTokenRead);
  });

  it('execs the runtime directly after scrubbing probe-only variables', () => {
    expect(source).toContain(
      'unset WHATSOUP_PREFLIGHT_IMPORT_ONLY WHATSOUP_PREFLIGHT_IMPORT_SENTINEL',
    );
    expect(source).toContain('exec "$NODE"');
    expect(source).toContain('"$REPO_ROOT/src/bootstrap.ts" "$INSTANCE"');
  });
});

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

type ManagedRoute = 'ambient-only' | 'private-file' | 'keyring' | 'opencode-auth';

interface ManagedBoundaryOptions {
  service?: 'zai-coding-plan' | 'minimax-coding-plan';
  distillModel?: string;
}

interface ManagedBoundaryResult {
  inherited: Record<string, string | null>;
  childKeys: Record<string, string>;
}

/**
 * Runs the launcher's real scrub, keyring helper and agent restore block, then
 * execs the real runtime resolver (lookupCredential via buildChildEnv) for a
 * coding-plan model (zai-coding-plan unless overridden) — the managed-service
 * boundary the scrub-list assertions above cannot exercise. Only
 * `security`/`secret-tool` are stubbed. The probe returns its result through a
 * dedicated file: the runtime's own logger writes to stdout (e.g. the Linux
 * secret-tool miss warning), so stdout is not a result channel.
 */
function runManagedCodingPlanBoundary(
  route: ManagedRoute,
  { service = 'zai-coding-plan', distillModel }: ManagedBoundaryOptions = {},
): ManagedBoundaryResult {
  const suffix = service === 'zai-coding-plan' ? 'zhipu' : service;
  const root = tmp.make('whatsoup-launcher-coding-plan');
  const fixture = writeKeychainFixture(root);
  const runtimeProbeNode = process.platform === 'darwin' ? fixture.node : process.execPath;
  const keychainResponses = route === 'keyring'
    ? JSON.stringify({ [service + '\u0000' + userInfo().username]: 'synthetic-keyring-' + suffix + '\n' })
    : '{}';
  const bin = join(root, 'bin');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(join(configHome, 'whatsoup', 'instances', 'fixture-agent'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configHome, 'whatsoup', 'instances', 'fixture-agent', 'config.json'),
    JSON.stringify({ name: 'fixture-agent', type: 'agent' }),
    { mode: 0o600 },
  );
  if (route === 'private-file') {
    const credentials = join(configHome, 'whatsoup', 'credentials');
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    writeFileSync(join(credentials, `${service}.key`), `synthetic-file-${suffix}\n`, { mode: 0o600 });
  }
  if (route === 'opencode-auth') {
    const authDir = join(dataHome, 'opencode');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(authDir, 'auth.json'),
      JSON.stringify({ [service]: { type: 'api', key: `synthetic-auth-${suffix}` } }),
      { mode: 0o600 },
    );
  }
  const keyringHit = route === 'keyring' ? 'yes' : 'no';
  const secretToolTrace = join(root, 'secret-tool-trace.txt');
  writeFileSync(join(bin, 'security'), [
    '#!/usr/bin/env bash',
    `if [ "${keyringHit}" = yes ] && [ "$1" = find-generic-password ] && [ "$3" = ${service} ]; then`,
    `  printf 'synthetic-keyring-${suffix}\\n'; exit 0`,
    'fi',
    "echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2",
    'exit 44',
    '',
  ].join('\n'), { mode: 0o700 });
  writeFileSync(join(bin, 'secret-tool'), [
    '#!/usr/bin/env bash',
    `trace=${JSON.stringify(secretToolTrace)}`,
    'if [ "$1" = "--help" ]; then',
    "  printf '%s\\n' 'secret-tool:probe' >> \"$trace\"",
    '  exit 0',
    'fi',
    `if [ "${keyringHit}" = yes ] && [ "$1" = lookup ] && [ "$2" = service ] && [ "$3" = ${service} ]; then`,
    "  printf '%s\\n' 'secret-tool:lookup' >> \"$trace\"",
    `  printf 'synthetic-keyring-${suffix}\\n'; exit 0`,
    'fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o700 });

  const probe = join(root, 'runtime-probe.ts');
  const resultFile = join(root, 'probe-result.json');
  writeFileSync(probe, [
    "import { writeFileSync } from 'node:fs';",
    `import { buildChildEnv } from ${JSON.stringify(resolve('src/runtimes/agent/session.ts'))};`,
    `import { SERVICE_ENV_MAP } from ${JSON.stringify(resolve('src/lib/provider-key-service.ts'))};`,
    `const env = buildChildEnv('opencode-cli', undefined, '${service}/synthetic-model');`,
    'const names = [...new Set(Object.values(SERVICE_ENV_MAP))];',
    'const childKeys = Object.fromEntries(names.filter((n) => Object.hasOwn(env, n)).map((n) => [n, env[n]]));',
    "const inherited = Object.fromEntries(['ZHIPU_API_KEY', 'ZAI_API_KEY', 'MINIMAX_API_KEY'].map((n) => [n, process.env[n] ?? null]));",
    `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ inherited, childKeys }), { flag: 'wx', mode: 0o600 });`,
    '',
  ].join('\n'));

  const source = readFileSync('deploy/whatsoup', 'utf8');
  const script = join(root, 'launcher-boundary.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'INSTANCE=fixture-agent',
    sliceBetween(source, '_DISTILL_CAPTURE_DEEPSEEK=', '\n\n# POSIX-portable symlink resolution'),
    `NODE=${JSON.stringify(fixture.node)}`,
    `SCRIPT_DIR=${JSON.stringify(resolve('deploy'))}`,
    `. ${JSON.stringify(resolve('deploy/lib/bounded-exec.sh'))}`,
    sliceBetween(source, 'macos_keychain_lookup() {', '\n# Pinned Node path'),
    sliceBetween(source, '# Detect instance type', '\n# Health server auth token'),
    `exec ${JSON.stringify(runtimeProbeNode)} --disable-warning=ExperimentalWarning --experimental-strip-types ${JSON.stringify(probe)}`,
    '',
  ].join('\n'));
  chmodSync(script, 0o700);

  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: root,
      USER: 'fixture-user',
      TMPDIR: root,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
      WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: join(root, 'keychain-probe.jsonl'),
      WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
      WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: keychainResponses,
      // The documented service-manager values (systemd Environment=, launchd
      // EnvironmentVariables) arrive exactly like this: inherited by the wrapper.
      ZHIPU_API_KEY: 'synthetic-ambient-zhipu',
      ZAI_API_KEY: 'synthetic-ambient-zai',
      MINIMAX_API_KEY: 'synthetic-ambient-minimax',
      ...(distillModel === undefined ? {} : { WHATSOUP_HANDOFF_DISTILL_MODEL: distillModel }),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  if (route === 'keyring' && process.platform !== 'darwin') {
    expect(existsSync(secretToolTrace), output).toBe(true);
    expect(readFileSync(secretToolTrace, 'utf8')).toBe('secret-tool:probe\nsecret-tool:lookup\n');
  }
  // Runtime logs may share stdout/stderr; they must never carry a key value.
  expect(output).not.toContain('synthetic-');
  expect(existsSync(resultFile), output).toBe(true);
  return JSON.parse(readFileSync(resultFile, 'utf8')) as ManagedBoundaryResult;
}

describe('deploy/whatsoup managed coding-plan credential boundary', () => {
  const scrubbed = { ZHIPU_API_KEY: null, ZAI_API_KEY: null, MINIMAX_API_KEY: null };

  it('drops a service-manager-only ZHIPU_API_KEY: the runtime forwards no key', () => {
    expect(runManagedCodingPlanBoundary('ambient-only')).toEqual({ inherited: scrubbed, childKeys: {} });
  }, 30_000);

  it('forwards the private credential file value, not the ambient value', () => {
    expect(runManagedCodingPlanBoundary('private-file')).toEqual({
      inherited: scrubbed,
      childKeys: { ZHIPU_API_KEY: 'synthetic-file-zhipu' },
    });
  }, 30_000);

  it('forwards the platform keyring value, not the ambient value', () => {
    expect(runManagedCodingPlanBoundary('keyring')).toEqual({
      inherited: scrubbed,
      childKeys: { ZHIPU_API_KEY: 'synthetic-keyring-zhipu' },
    });
  }, 30_000);

  it('forwards the OpenCode auth.json login, not the ambient value', () => {
    expect(runManagedCodingPlanBoundary('opencode-auth')).toEqual({
      inherited: scrubbed,
      childKeys: { ZHIPU_API_KEY: 'synthetic-auth-zhipu' },
    });
  }, 30_000);

  // The selected-distiller restore is a deliberate exception to the scrub, and
  // minimax-coding-plan shares the restored variable (docs/configuration.md).
  it('without a distiller, a minimax-coding-plan fallback forwards its own stored key', () => {
    expect(runManagedCodingPlanBoundary('private-file', { service: 'minimax-coding-plan' })).toEqual({
      inherited: scrubbed,
      childKeys: { MINIMAX_API_KEY: 'synthetic-file-minimax-coding-plan' },
    });
  }, 30_000);

  it('a MiniMax distiller restores the captured MINIMAX_API_KEY, shadowing the coding-plan key', () => {
    expect(runManagedCodingPlanBoundary('private-file', {
      service: 'minimax-coding-plan',
      distillModel: 'MiniMax-M2.7',
    })).toEqual({
      inherited: { ...scrubbed, MINIMAX_API_KEY: 'synthetic-ambient-minimax' },
      childKeys: { MINIMAX_API_KEY: 'synthetic-ambient-minimax' },
    });
  }, 30_000);
});
