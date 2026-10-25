import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve('.');
const wrapperPath = path.join(repoRoot, 'deploy/whatsoup');
const readerPath = path.join(repoRoot, 'deploy/lib/read-private-credential.mjs');
const node = process.execPath;
const tmpRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-private-credential-'));
  tmpRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, 'utf8');
  fs.chmodSync(filePath, 0o700);
}

function extractedKeyringLookup(): string {
  const source = fs.readFileSync(wrapperPath, 'utf8');
  const start = source.indexOf('macos_keychain_lookup() {');
  const end = source.indexOf('\n}\n\n# Pinned Node path', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

function runReader(filePath: string): ReturnType<typeof spawnSync> {
  return spawnSync(node, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    readerPath,
  ], {
    input: `${filePath}\0`,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy private credential reader', () => {
  it('uses the runtime private-file contract and trims a valid credential', () => {
    const root = makeRoot();
    const credentials = path.join(root, 'credentials');
    const credential = path.join(credentials, 'pinecone.key');
    fs.mkdirSync(credentials, { mode: 0o700 });
    fs.writeFileSync(credential, ' file-value \n', { mode: 0o600 });

    const result = runReader(credential);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('file-value');
  });

  it('treats a missing file as a keyring-fallback miss but rejects unsafe files', () => {
    const root = makeRoot();
    const credentials = path.join(root, 'credentials');
    const missing = path.join(credentials, 'missing.key');
    const target = path.join(root, 'target.key');
    const link = path.join(credentials, 'pinecone.key');
    fs.mkdirSync(credentials, { mode: 0o700 });
    fs.writeFileSync(target, 'not-used', { mode: 0o600 });

    const missingResult = runReader(missing);
    expect(missingResult.status).toBe(0);
    expect(missingResult.stdout).toBe('');

    fs.symlinkSync(target, link);
    const unsafeResult = runReader(link);
    expect(unsafeResult.status).toBe(1);
    expect(unsafeResult.stderr).toContain('FATAL: private credential file could not be read safely');

    fs.unlinkSync(link);
    fs.writeFileSync(link, 'not-private', { mode: 0o600 });
    fs.chmodSync(link, 0o644);
    const publicResult = runReader(link);
    expect(publicResult.status).toBe(1);
    expect(publicResult.stderr).toContain('FATAL: private credential file could not be read safely');
  });
});

describe('deploy/whatsoup unscoped credential precedence', () => {
  function runLookup(scenario: 'file' | 'missing' | 'unsafe', scoped: boolean): { status: number; stdout: string; stderr: string; log: string } {
    const root = makeRoot();
    const bin = path.join(root, 'bin');
    const config = path.join(root, 'config');
    const credentials = path.join(config, 'whatsoup', 'credentials');
    const credential = path.join(credentials, 'pinecone.key');
    const target = path.join(root, 'target.key');
    const logPath = path.join(root, 'security.log');
    fs.mkdirSync(bin);
    fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
    if (scenario === 'file') fs.writeFileSync(credential, 'private-file-value\n', { mode: 0o600 });
    if (scenario === 'unsafe') {
      fs.writeFileSync(target, 'private-file-value\n', { mode: 0o600 });
      fs.symlinkSync(target, credential);
    }
    writeExecutable(path.join(bin, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOOKUP_LOG"\nprintf 'keychain-value\\n'\n`);
    writeExecutable(path.join(bin, 'uname'), '#!/usr/bin/env bash\nprintf \'Darwin\\n\'\n');

    const script = path.join(root, 'lookup.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash
set -u
PATH=${JSON.stringify(bin)}:"$PATH"
export LOOKUP_LOG=${JSON.stringify(logPath)}
unset PINECONE_API_KEY
NODE=${JSON.stringify(node)}
SCRIPT_DIR=${JSON.stringify(path.join(repoRoot, 'deploy'))}
XDG_CONFIG=${JSON.stringify(config)}
. ${JSON.stringify(path.join(repoRoot, 'deploy/lib/bounded-exec.sh'))}
${extractedKeyringLookup()}
if value="$(keyring_lookup pinecone PINECONE_API_KEY${scoped ? ' user fixture-user' : ''})"; then
  printf 'ok:%s\\n' "$value"
else
  printf 'failed\\n' >&2
  exit 47
fi
`, 'utf8');
    fs.chmodSync(script, 0o700);
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8' });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
    };
  }

  it('prefers an unscoped private file before macOS Keychain', () => {
    const result = runLookup('file', false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok:private-file-value\n');
    expect(result.log).toBe('');
  });

  it('keeps scoped lookups isolated from unscoped private credential files', () => {
    const result = runLookup('file', true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok:keychain-value\n');
    expect(result.log).toContain('security find-generic-password -s pinecone -a fixture-user -w');
  });

  it('falls back to Keychain only for an absent file and fails closed for an unsafe one', () => {
    const missing = runLookup('missing', false);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('ok:keychain-value\n');
    expect(missing.log).toContain('security find-generic-password -s pinecone');

    const unsafe = runLookup('unsafe', false);
    expect(unsafe.status).toBe(47);
    expect(unsafe.stderr).toContain('FATAL: private credential file could not be read safely');
    expect(unsafe.log).toBe('');
  });
});
