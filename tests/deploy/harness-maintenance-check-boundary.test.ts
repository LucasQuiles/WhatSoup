import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OLD,
  T,
  TARGET,
  allFixtureCalls,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  makeHarness,
  portableInstance,
  run,
  writeExec,
  type Harness,
} from './harness-maintenance-fixture-helper.ts';

// The --check side-effect boundary for the whole maintenance script, not only the agent CLI step.
//
// Every command the job could mutate through is replaced by a stub that records its invocation:
// the package manager, the service manager, the alert sender, the agent CLI (the compiled native
// fixture), the npm-installed harnesses, local MCP binaries and runtime binaries. Two independent
// oracles decide the result: the recorded invocations, and a snapshot of the temporary HOME taken
// before and after the run. Only the permitted inspection artifacts may differ.
//
// Known limits of these oracles:
// - The snapshots cover the temporary HOME and a TMPDIR placed outside it (where mktemp and the
//   bounded-exec control files go on a real host); a write to any other absolute path, such as a
//   state directory overridden outside HOME, is caught only if it goes through a recorded stub.
// - The job's temporary directory is checked to be inside that TMPDIR through the npm cache
//   directory placed in it, and its removal through the TMPDIR snapshot.
// - The pinned node is the real one and is not recorded; writes it makes are seen only through
//   the HOME snapshot.

const systemTmps: string[] = [];

beforeAll(buildNativeFixture);
afterAll(() => {
  cleanupHarnesses();
  for (const dir of systemTmps) rmSync(dir, { recursive: true, force: true });
});

// Read-only verbs a check run may use; anything else recorded by a stub is a boundary violation.
const NPM_READ_ONLY = [/^--version$/, /^config get min-release-age$/, /^view \S+ (version|time --json)$/, /^ls -g --depth=0$/];
const SYSTEMCTL_READ_ONLY = [/^--user list-units /, /^--user show-environment$/, /^--user show /, /^--user is-active /];
const APT_READ_ONLY = [/^list --upgradable$/];

// Helpers the script, its sourced libraries and check-unit-drift.sh call by bare name.
const SHADOWED_HELPERS = [
  'awk', 'basename', 'cat', 'chmod', 'cmp', 'cp', 'cut', 'date', 'dirname', 'env', 'grep', 'head', 'id',
  'ln', 'ls', 'mkdir', 'mkfifo', 'mktemp', 'mv', 'ps', 'readlink', 'rm', 'rmdir', 'sed', 'sleep', 'sort',
  'stat', 'tail', 'tee', 'timeout', 'touch', 'tr', 'uname', 'wc', 'xargs',
];

/** A stub that records "<name> <args>"; exec.log collects commands a check run must never execute. */
function recorder(h: Harness, name: string, log = 'exec.log'): string {
  return ['#!/bin/sh', `printf '%s %s\\n' ${name} "$*" >> "${path.join(h.home, log)}"`, 'echo 0.0.1', 'exit 0', ''].join('\n');
}

/** An npm-layout package: <bin link> -> <root>/lib/node_modules/<pkg>/bin/<file>, with its package.json. */
function npmPackage(h: Harness, root: string, pkg: string, version: string, binLink: string, name: string): void {
  const pkgDir = path.join(root, 'lib/node_modules', pkg);
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version }));
  const entry = path.join(pkgDir, 'bin', name);
  writeExec(entry, recorder(h, name));
  mkdirSync(path.dirname(binLink), { recursive: true });
  symlinkSync(entry, binLink);
}

/** A HOME with a stub for every executable the job can reach, and an agent CLI update pending. */
function boundaryHarness(): Harness {
  const h = makeHarness();
  portableInstance(h, 'alpha');
  // npm records its cache setting too, so a check run can be held to a throwaway cache.
  writeExec(path.join(h.fakeBin, 'npm'), readFileSync(path.join(h.fakeBin, 'npm'), 'utf8')
    .replace('printf \'%s\\n\' "$*" >> "$HM_NPM_LOG"', 'printf \'%s\\n\' "$*" >> "$HM_NPM_LOG"; printf \'%s\\n\' "${npm_config_cache:-unset}" >> "$HM_NPM_LOG.cache"'));
  npmPackage(h, path.join(h.home, 'codex-node'), '@openai/codex', '0.1.0', path.join(h.fakeBin, 'codex'), 'codex');
  npmPackage(h, path.join(h.home, 'npm-global'), 'opencode-ai', '1.0.0', path.join(h.home, 'npm-global/bin/opencode'), 'opencode');
  for (const name of ['pinecone-mcp', 'playwright-mcp', 'python3']) writeExec(path.join(h.fakeBin, name), recorder(h, name));
  writeExec(path.join(h.fakeBin, 'apt'), recorder(h, 'apt', 'apt.log'));
  // A runtime binary on the job's rewritten PATH, ahead of the pinned node's directory.
  writeExec(path.join(h.home, '.local/bin/node'), recorder(h, 'node'));
  return h;
}

interface Entry { type: string; mode: number; size: number; digest: string; link: string }

function snapshot(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const st = lstatSync(file);
      const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      out.set(path.relative(root, file), {
        type,
        mode: st.mode,
        size: type === 'file' ? st.size : 0,
        digest: type === 'file' ? createHash('sha256').update(readFileSync(file)).digest('hex') : '',
        link: type === 'link' ? readlinkSync(file) : '',
      });
      if (type === 'dir') walk(file);
    }
  };
  walk(root);
  return out;
}

// The permitted inspection artifacts of a check run: the job's own state directory with its final
// state and run log. The recorders' logs belong to the test, not to the job.
const PERMITTED = new Set([
  '.cache',
  '.cache/whatsoup',
  '.cache/whatsoup/harness-maintenance',
  '.cache/whatsoup/harness-maintenance/state.json',
  '.cache/whatsoup/harness-maintenance/run.log',
]);
const TEST_LOGS = new Set(['exec.log', 'apt.log', 'fixture.log', 'npm.log', 'npm.log.cache', 'alert.log', 'systemd-fixture/argv.log']);

function changedPaths(before: Map<string, Entry>, after: Map<string, Entry>): string[] {
  const changed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (PERMITTED.has(key) || TEST_LOGS.has(key)) continue;
    if (JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))) changed.push(key);
  }
  return changed.sort();
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function outside(recorded: string[], allowed: RegExp[]): string[] {
  return recorded.filter((line) => !allowed.some((re) => re.test(line)));
}

describe('harness-maintenance.sh --check side-effect boundary', () => {
  it('runs no mutator, no agent CLI and no wrapper, and writes only its own state', () => {
    const h = boundaryHarness();
    // A temporary directory outside HOME, as on a real host, where the run's own temporary
    // directory and the bounded-exec control files are created.
    const systemTmp = mkdtempSync(path.join(tmpdir(), 'hm-systmp-'));
    systemTmps.push(systemTmp);
    const before = snapshot(h.home);
    const tmpBefore = snapshot(systemTmp);
    const r = run(h, ['--check'], { TMPDIR: systemTmp });

    expect(r.state?.mode, r.stderr).toBe('check');
    // The agent CLI update is still planned, only not applied.
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'drift', before: OLD, target: TARGET });

    // Oracle 1: recorded invocations.
    expect(allFixtureCalls(h)).toEqual([]);
    expect(lines(path.join(h.home, 'exec.log'))).toEqual([]);
    expect(lines(h.alertLog)).toEqual([]);
    expect(outside(lines(h.npmLog), NPM_READ_ONLY)).toEqual([]);
    expect(outside(lines(path.join(h.systemdDir, 'argv.log')), SYSTEMCTL_READ_ONLY)).toEqual([]);
    const apt = lines(path.join(h.home, 'apt.log')).map((line) => line.replace(/^apt /, ''));
    expect(apt).toEqual(['list --upgradable']);
    expect(outside(apt, APT_READ_ONLY)).toEqual([]);
    // npm's own cache is a write too: a check run points every npm call at one cache inside the
    // run's temporary directory, which is gone once the run exits.
    const caches = [...new Set(lines(`${h.npmLog}.cache`))];
    expect(caches).toHaveLength(1);
    expect(path.basename(caches[0]!)).toBe('npm-cache');
    expect(existsSync(path.dirname(caches[0]!))).toBe(false);

    // Oracle 2: the filesystem. Nothing outside the permitted artifacts changed. (The temporary
    // directory's removal is asserted above through the npm cache placed inside it.)
    expect(changedPaths(before, snapshot(h.home))).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    // Oracle 3: the temporary directory outside HOME is left exactly as found.
    expect(path.dirname(path.dirname(caches[0]!))).toBe(systemTmp);
    expect(changedPaths(tmpBefore, snapshot(systemTmp))).toEqual([]);
  }, T);

  it('reads the npm-installed harness versions from package metadata instead of running them', () => {
    const h = boundaryHarness();
    const r = run(h, ['--check']);
    expect(events(r, 'codex')[0]).toMatchObject({ before: '0.1.0' });
    expect(events(r, 'opencode')[0]).toMatchObject({ status: 'checked', before: '1.0.0' });
    expect(lines(path.join(h.home, 'exec.log'))).toEqual([]);
  }, T);

  it('reports an installed harness whose version is not statically readable as unknown, not missing', () => {
    const h = boundaryHarness();
    // A plain executable with no package metadata behind it.
    const bin = path.join(h.home, 'npm-global/bin/opencode');
    rmSync(bin);
    writeExec(bin, recorder(h, 'opencode'));
    const r = run(h, ['--check']);
    expect(events(r, 'opencode')[0]).toMatchObject({ status: 'unknown' });
    expect(events(r, 'opencode')[0]!.message).toContain('check mode');
    expect(lines(path.join(h.home, 'exec.log'))).toEqual([]);
  }, T);

  it('runs no helper from a user-writable PATH directory, and still reports binaries found there by path', () => {
    const h = boundaryHarness();
    // Pass-through recorders for every helper the script and its libraries call by name, in both
    // directories the job puts first on its own PATH.
    const shadowLog = path.join(h.home, 'shadow.log');
    for (const dir of [path.join(h.home, '.local/bin'), path.join(h.home, 'npm-global/bin')]) {
      mkdirSync(dir, { recursive: true });
      for (const name of SHADOWED_HELPERS) {
        const real = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => path.join(d, name)).find((f) => existsSync(f));
        writeExec(path.join(dir, name), ['#!/bin/sh', `printf '%s\\n' ${name} >> "${shadowLog}"`,
          real ? `exec ${real} "$@"` : 'exit 127', ''].join('\n'));
      }
    }
    // Only located, never executed: a local MCP binary in ~/.local/bin.
    const mcp = path.join(h.home, '.local/bin/google-workspace-mcp');
    writeExec(mcp, recorder(h, 'google-workspace-mcp'));

    // As in the shipped launchd job, whose own PATH starts with ~/.local/bin.
    const inherited = `${path.join(h.home, '.local/bin')}:${path.join(h.home, 'npm-global/bin')}:${h.env.PATH}`;
    const r = run(h, ['--check'], { PATH: inherited });
    expect(r.state?.mode, r.stderr).toBe('check');
    expect([...new Set(lines(shadowLog))]).toEqual([]);
    expect(events(r, 'local-bin:google-workspace-mcp')[0]).toMatchObject({ status: 'present' });
    expect(events(r, 'local-bin:google-workspace-mcp')[0]!.message).toContain(mcp);
    expect(lines(path.join(h.home, 'exec.log'))).toEqual([]);
  }, T);

  it('runs only the pinned npm: with it absent, every npm check is unknown and no other npm runs', () => {
    const h = boundaryHarness();
    const empty = path.join(h.home, 'empty-pinned-bin');
    mkdirSync(empty);
    const npmCalls = path.join(h.home, 'other-npm.log');
    const npmRecorder = ['#!/bin/sh', `printf '%s\\n' "$*" >> "${npmCalls}"`, 'exit 1', ''].join('\n');
    // Other npm binaries a PATH search or the node-version loop could reach. The fake npm on the
    // inherited PATH (fakebin) records into npm.log.
    for (const dir of ['.local/bin', 'npm-global/bin', '.nvm/versions/node/v24.13.0/bin', '.nvm/versions/node/v24.15.0/bin']) {
      mkdirSync(path.join(h.home, dir), { recursive: true });
      writeExec(path.join(h.home, dir, 'npm'), npmRecorder);
    }
    // opencode absent, so its install-availability lookup is reached too.
    rmSync(path.join(h.home, 'npm-global/bin/opencode'));

    const r = run(h, ['--check'], { WHATSOUP_CODEX_NODE_BIN_DIR: empty });
    expect(r.state?.mode, r.stderr).toBe('check');
    expect(lines(npmCalls)).toEqual([]);
    expect(lines(h.npmLog)).toEqual([]);
    for (const component of ['codex-npm-cooldown', 'claude', 'codex', 'opencode']) {
      const last = events(r, component).at(-1);
      expect(last, component).toMatchObject({ status: 'unknown' });
      expect(last!.message, component).toContain('pinned npm');
    }
    for (const version of ['24.13.0', '24.15.0']) {
      expect(events(r, `npm-global:${version}`)[0], version).toMatchObject({ status: 'skipped' });
    }
  }, T);

  it('reports a binary behind a relative PATH entry as unknown, not missing, and runs nothing', () => {
    const h = boundaryHarness();
    rmSync(path.join(h.home, 'npm-global/bin/opencode'));
    // A relative entry ahead of fakebin, where the local MCP and runtime stubs are: what it would
    // find depends on the working directory of whatever runs it.
    const r = run(h, ['--check'], { PATH: `relative-bin:${h.env.PATH}` });
    expect(r.state?.mode, r.stderr).toBe('check');
    for (const component of ['local-bin:pinecone-mcp', 'runtime:python3', 'opencode']) {
      const last = events(r, component).at(-1);
      expect(last, component).toMatchObject({ status: 'unknown' });
      expect(last!.message, component).toContain('relative PATH entry');
    }
    expect(lines(path.join(h.home, 'exec.log'))).toEqual([]);
  }, T);

  it('exits 1 before any step without a usable node, leaving no state and no temporary directory', () => {
    const h = boundaryHarness();
    const systemTmp = mkdtempSync(path.join(tmpdir(), 'hm-systmp-'));
    systemTmps.push(systemTmp);
    const tmpBefore = snapshot(systemTmp);
    const r = run(h, ['--check'], { TMPDIR: systemTmp, WHATSOUP_NODE_BIN: path.join(h.home, 'no-such-node') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FATAL: Node is required');
    expect(r.state).toBeNull();
    expect(changedPaths(tmpBefore, snapshot(systemTmp))).toEqual([]);
  }, T);

  it('negative control: a normal run does reach the stubs, so the recorders can see a violation', () => {
    const h = boundaryHarness();
    const r = run(h);
    expect(r.state?.mode).toBe('run');
    expect(lines(h.npmLog).some((line) => line.startsWith('install '))).toBe(true);
    expect(allFixtureCalls(h).some((line) => / install /.test(line))).toBe(true);
    expect(lines(path.join(h.home, 'exec.log')).length).toBeGreaterThan(0);
  }, T);
});
