import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyClaudeExecutable } from '../../scripts/harness-maintenance-guard.ts';

// Static executable classifier (task d03). It reads links, stats and file heads only; nothing
// it classifies is ever executed. A version taken from a path or package.json is "configured",
// never "observed".
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const guard = path.join(repoRoot, 'scripts', 'harness-maintenance-guard.ts');

let root: string;
let home: string;
let versions: string;
let sentinel: string;
// Script fixtures that write the sentinel if they are ever executed.
let fakeNative: string;
let npmBin: string;
let otherPackageBin: string;
let scriptWrapper: string;

// ELF magic followed by padding: recognisably native, never runnable.
const NATIVE_BYTES = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);

function file(p: string, content: string | Buffer, mode = 0o755): string {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

function link(p: string, target: string): string {
  mkdirSync(path.dirname(p), { recursive: true });
  symlinkSync(target, p);
  return p;
}

const sentinelScript = (body: string) => `#!/bin/sh\ntouch '${sentinel}'\n${body}\n`;

interface CliResult {
  status: number | null;
  lines: string[];
  json: () => Record<string, unknown>;
}

function resolveCli(args: string[]): CliResult {
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', guard, '--claude-resolve', ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' },
  );
  // Only the single terminating newline is removed: a blank line anywhere is a contract breach.
  const lines = child.stdout === '' ? [] : child.stdout.replace(/\n$/, '').split('\n');
  return { status: child.status, lines, json: () => JSON.parse(lines.at(-1) ?? '') as Record<string, unknown> };
}

function classify(bin: string): Record<string, unknown> {
  const result = resolveCli(['--bin', bin, '--home', home]);
  expect(result.status).toBe(0);
  expect(result.lines).toHaveLength(1);
  return result.json();
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'harness-claude-resolve-')));
  home = path.join(root, 'home');
  versions = path.join(home, '.local', 'share', 'claude', 'versions');
  sentinel = path.join(root, 'EXECUTED');
  file(path.join(versions, '2.1.282'), NATIVE_BYTES);

  fakeNative = file(path.join(versions, '2.1.290'), sentinelScript('exit 0'));
  const pkg = path.join(root, 'npm', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  file(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.200' }), 0o644);
  file(path.join(pkg, 'cli.js'), sentinelScript('exit 0'));
  npmBin = link(path.join(root, 'npm', 'bin', 'claude'), '../lib/node_modules/@anthropic-ai/claude-code/cli.js');
  const other = path.join(root, 'other-npm', 'node_modules', 'not-the-cli');
  file(path.join(other, 'package.json'), JSON.stringify({ name: 'not-the-cli', version: '1.0.0' }), 0o644);
  otherPackageBin = file(path.join(other, 'cli.js'), sentinelScript('exit 0'));
  scriptWrapper = file(
    path.join(home, 'wrap2', 'claude'),
    sentinelScript(`exec ${path.join(versions, '2.1.282')} "$@"`),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('--claude-resolve native layout', () => {
  it('classifies an absolute link into the versions directory as native with a configured version', () => {
    const bin = link(path.join(home, '.local', 'bin', 'claude'), path.join(versions, '2.1.282'));
    expect(classify(bin)).toMatchObject({
      kind: 'native',
      layout: 'native',
      configuredVersion: '2.1.282',
      configuredVersionSource: 'native-path',
      observedVersion: null,
    });
  });

  it('resolves a relative link against the directory that holds it', () => {
    const bin = link(path.join(home, 'rel', 'claude'), '../.local/share/claude/versions/2.1.282');
    expect(classify(bin)).toMatchObject({ kind: 'native', configuredVersion: '2.1.282' });
  });

  it('resolves a relative link inside a symlinked directory against the real directory', () => {
    mkdirSync(path.join(home, 'links', 'deep', 'bin'), { recursive: true });
    link(path.join(home, 'links', 'deep', 'bin', 'claude'), '../../../.local/share/claude/versions/2.1.282');
    link(path.join(home, 'aliasbin'), path.join(home, 'links', 'deep', 'bin'));
    expect(classify(path.join(home, 'aliasbin', 'claude'))).toMatchObject({ kind: 'native' });
  });

  it('follows a chain of links and reports every hop', () => {
    const first = link(path.join(home, 'chain', 'b'), path.join(versions, '2.1.282'));
    const bin = link(path.join(home, 'chain', 'a'), first);
    const result = classify(bin);
    expect(result.kind).toBe('native');
    expect(result.chain).toEqual([bin, first, path.join(versions, '2.1.282')]);
  });

  it('does not accept a shebang script placed at a native version path', () => {
    const result = classify(link(path.join(home, 'fake', 'claude'), fakeNative));
    expect(result.kind).not.toBe('native');
    expect(result.layout).toBe('other');
  });

  it('reports a non-executable native file as not-executable', () => {
    const plain = file(path.join(versions, '2.1.291'), NATIVE_BYTES, 0o644);
    expect(classify(link(path.join(home, 'noexec', 'claude'), plain)).kind).toBe('not-executable');
  });
});

describe('--claude-resolve link failures', () => {
  it('reports a missing path', () => {
    expect(classify(path.join(home, 'absent', 'claude'))).toMatchObject({ kind: 'missing', layout: 'other' });
  });

  it('reports a dangling link as broken-link', () => {
    expect(classify(link(path.join(home, 'broken', 'claude'), path.join(root, 'nowhere'))).kind).toBe('broken-link');
  });

  it('reports a link cycle as link-loop', () => {
    const a = path.join(home, 'loop', 'a');
    link(path.join(home, 'loop', 'b'), a);
    link(a, path.join(home, 'loop', 'b'));
    expect(classify(a).kind).toBe('link-loop');
  });

  it('bounds a long acyclic chain as link-loop', () => {
    let target = path.join(versions, '2.1.282');
    for (let i = 0; i < 50; i += 1) target = link(path.join(home, 'long', `l${i}`), target);
    expect(classify(target).kind).toBe('link-loop');
  });

  it('classifies a FIFO as other without blocking', () => {
    const fifo = path.join(home, 'fifo', 'claude');
    mkdirSync(path.dirname(fifo), { recursive: true });
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    expect(classify(fifo).kind).toBe('other');
  });

  it('classifies a directory as other', () => {
    mkdirSync(path.join(home, 'dir', 'claude'), { recursive: true });
    expect(classify(path.join(home, 'dir', 'claude')).kind).toBe('other');
  });
});

describe('--claude-resolve npm and wrapper layouts', () => {
  it('detects an npm install from its package.json before any shebang test', () => {
    expect(classify(npmBin)).toMatchObject({
      kind: 'npm',
      layout: 'npm',
      configuredVersion: '2.1.200',
      configuredVersionSource: 'package-json',
      observedVersion: null,
    });
  });

  it('does not treat a different package as the npm layout', () => {
    expect(classify(otherPackageBin).kind).not.toBe('npm');
  });

  it('resolves a single exec wrapper to its absolute target without running it', () => {
    const bin = file(path.join(home, 'wrap', 'claude'), `#!/bin/sh\nexec "${path.join(versions, '2.1.282')}" "$@"\n`);
    expect(classify(bin)).toMatchObject({
      kind: 'wrapper',
      layout: 'wrapper',
      wrapperTarget: path.join(versions, '2.1.282'),
      target: { kind: 'native', configuredVersion: '2.1.282' },
    });
  });

  it('leaves any other script as wrapper-unresolved', () => {
    expect(classify(scriptWrapper)).toMatchObject({ kind: 'wrapper-unresolved', layout: 'wrapper' });
    const envWrapper = file(
      path.join(home, 'wrap3', 'claude'),
      `#!/bin/sh\nFOO=1 exec ${path.join(versions, '2.1.282')} "$@"\n`,
    );
    expect(classify(envWrapper).kind).toBe('wrapper-unresolved');
  });
});

describe('--claude-resolve trust', () => {
  it('marks a world-writable target as untrusted', () => {
    const target = file(path.join(home, 'ww', 'native'), NATIVE_BYTES, 0o757);
    expect(classify(target)).toMatchObject({ kind: 'untrusted', layout: 'other' });
  });

  it('marks a target in a world-writable directory without the sticky bit as untrusted', () => {
    const target = file(path.join(home, 'wwdir', 'native'), NATIVE_BYTES);
    chmodSync(path.dirname(target), 0o777);
    expect(classify(target).kind).toBe('untrusted');
  });

  it('marks a target owned by an untrusted user as untrusted', () => {
    expect(
      classifyClaudeExecutable({ bin: path.join(versions, '2.1.282'), home, trustedUids: [] }).kind,
    ).toBe('untrusted');
  });
});

describe('--claude-resolve never executes what it classifies', () => {
  it('leaves the sentinel absent after classifying every script fixture', () => {
    // Positive control: a fixture does write the sentinel when it is actually run.
    expect(spawnSync(otherPackageBin).status).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(sentinel);

    for (const bin of [fakeNative, npmBin, otherPackageBin, scriptWrapper]) classify(bin);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe('--claude-resolve CLI arguments', () => {
  it('rejects a missing or relative --bin and a missing --home with exit 2 and one JSON line', () => {
    for (const args of [['--home', '/tmp'], ['--bin', 'claude', '--home', '/tmp'], ['--bin', '/tmp/claude']]) {
      const result = resolveCli(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.lines).toHaveLength(1);
      expect(result.json()).toMatchObject({ action: 'error', error: { code: 'INVALID_ARGUMENT' } });
    }
  });
});
