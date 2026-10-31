import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface KeychainFixture {
  node: string;
  preload: string;
  securityFixture: string;
}

/**
 * Test-only launcher for read-keychain-secret.mjs. The preload intercepts the
 * named ESM execFileSync import before the helper evaluates, then calls only the
 * absolute fixture below. It never resolves a credential executable through PATH.
 */
export function writeKeychainFixture(root: string): KeychainFixture {
  const securityFixture = join(root, 'synthetic-security');
  const preload = join(root, 'keychain-security-preload.mjs');
  const node = join(root, 'node-with-keychain-fixture');

  writeFileSync(securityFixture, [
    '#!/bin/sh',
    'if [ -n "${WHATSOUP_TEST_KEYCHAIN_COMPAT_LOG:-}" ]; then',
    '  /usr/bin/printf "security %s\\n" "$*" >> "$WHATSOUP_TEST_KEYCHAIN_COMPAT_LOG"',
    'fi',
    'if [ "${WHATSOUP_TEST_KEYCHAIN_FIXTURE_MODE:-value}" = hang ]; then',
    '  exec /bin/sleep 30',
    'fi',
    '/usr/bin/printf "%s" "${WHATSOUP_TEST_KEYCHAIN_FIXTURE_VALUE:-}"',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(securityFixture, 0o700);

  const preloadSource = [
    "import childProcess from 'node:child_process';",
    "import { appendFileSync, statSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    '',
    'const armed = process.env.WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED;',
    'const logPath = process.env.WHATSOUP_TEST_KEYCHAIN_PROBE_LOG;',
    'const responseJson = process.env.WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES;',
    'const fixturePath = process.env.WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE;',
    "if (armed !== '1' || !logPath || !responseJson || !fixturePath) {",
    "  throw new Error('unarmed keychain test preload');",
    '}',
    'const responses = JSON.parse(responseJson);',
    "if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {",
    "  throw new Error('invalid synthetic keychain response map');",
    '}',
    "if (!fixturePath.startsWith('/') || !statSync(fixturePath).isFile()) {",
    "  throw new Error('invalid synthetic keychain fixture');",
    '}',
    'const originalExecFileSync = childProcess.execFileSync;',
    "appendFileSync(logPath, JSON.stringify({ phase: 'ready', fixturePath }) + '\\n');",
    '',
    'childProcess.execFileSync = (command, rawArgs = [], options = {}) => {',
    "  if (command !== 'security') {",
    "    throw new Error('unexpected synthetic child command');",
    '  }',
    '  const args = rawArgs.map(String);',
    "  const key = String(args[2] ?? '') + '\\u0000' + String(args[4] ?? '');",
    '  if (!Object.hasOwn(responses, key)) {',
    "    const error = new Error('unmapped synthetic keychain read');",
    '    error.code = 1;',
    '    throw error;',
    '  }',
    '  const response = responses[key];',
    '  const childEnv = options.env ?? process.env;',
    '  appendFileSync(logPath, JSON.stringify({',
    "    phase: 'exec',",
    '    command,',
    '    args,',
    '    childPath: childEnv.PATH ?? null,',
    '    childHome: childEnv.HOME ?? null,',
    "    childHasSentinel: Object.hasOwn(childEnv, 'WHATSOUP_TEST_KEYCHAIN_CHILD_ENV_SENTINEL'),",
    '    timeout: options.timeout ?? null,',
    '    killSignal: options.killSignal ?? null,',
    '    maxBuffer: options.maxBuffer ?? null,',
    '    stdio: options.stdio ?? null,',
    "  }) + '\\n');",
    '  const fixtureEnv = {',
    '    ...childEnv,',
    "    ...(process.env.WHATSOUP_TEST_KEYCHAIN_COMPAT_LOG ? { WHATSOUP_TEST_KEYCHAIN_COMPAT_LOG: process.env.WHATSOUP_TEST_KEYCHAIN_COMPAT_LOG } : {}),",
    "    WHATSOUP_TEST_KEYCHAIN_FIXTURE_MODE: response && typeof response === 'object' ? response.mode ?? 'value' : 'value',",
    "    WHATSOUP_TEST_KEYCHAIN_FIXTURE_VALUE: typeof response === 'string' ? response : response?.value ?? '',",
    '  };',
    '  return originalExecFileSync(fixturePath, args, { ...options, env: fixtureEnv });',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n');
  writeFileSync(preload, preloadSource, { mode: 0o600 });
  chmodSync(preload, 0o600);

  writeFileSync(node, [
    '#!/bin/sh',
    'exec ' + JSON.stringify(process.execPath) + ' --import ' + JSON.stringify(pathToFileURL(preload).href) + ' "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(node, 0o700);
  return { node, preload, securityFixture };
}
