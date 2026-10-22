import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAY_MS,
  OLD,
  T,
  TARGET,
  allFixtureCalls,
  buildNativeFixture,
  cleanupHarnesses,
  events,
  fixtureCalls,
  installNative,
  makeHarness,
  portableInstance,
  run,
  writeExec,
  type Harness,
} from './harness-maintenance-fixture-helper.ts';

// The whole main path of the real script against registry and metadata faults, stale metadata,
// the --check exit contract and a non-native file inside the native versions directory.
//
// Oracles, each independent of the script's own report: the launcher link on disk, the native
// fixture's invocation log, the npm stub's log, the process exit code and, where the script's
// events are read, only their status and fields, never a re-derivation of its logic.

beforeAll(buildNativeFixture);
afterAll(cleanupHarnesses);

function harness(): Harness {
  const h = makeHarness();
  portableInstance(h, 'alpha');
  return h;
}

function claudeStatus(r: ReturnType<typeof run>): string | undefined {
  return events(r, 'claude').at(-1)?.status;
}

/** Replace the publish-time answer with `body` (written verbatim) for this harness. */
function publishTimes(h: Harness, body: string): void {
  writeFileSync(h.env.HM_NPM_TIME!, body);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('registry faults', () => {
  it('holds without installing when the registry lookup fails, and ends degraded', () => {
    const h = harness();
    // The package manager answers everything except the publish-time lookup, as when the
    // registry is unreachable.
    writeExec(path.join(h.fakeBin, 'npm'), readFileSync(path.join(h.fakeBin, 'npm'), 'utf8')
      .replace('"view @anthropic-ai/claude-code time --json")', '"view @anthropic-ai/claude-code time --json") echo "network ENOTFOUND" >&2; exit 1 ;;\n  "unreachable")'));
    const r = run(h);
    expect(claudeStatus(r)).toBe('unknown');
    expect(events(r, 'claude').at(-1)!.message).toContain('lookup failed rc=1');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    expect(r.state?.status).toBe('degraded');
    expect(r.status).toBe(1);
  }, T);

  it('holds on a publish-time answer that is not JSON', () => {
    const h = harness();
    publishTimes(h, '<html>proxy error</html>');
    const r = run(h);
    expect(claudeStatus(r)).toBe('held');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);

  it('holds on an empty publish-time answer with no releases', () => {
    const h = harness();
    publishTimes(h, '{}');
    const r = run(h);
    expect(claudeStatus(r)).toBe('held');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);
});

describe('stale or anomalous metadata', () => {
  it('never downgrades a launcher newer than every release the registry lists', () => {
    const h = harness();
    installNative(h, '2.1.290');
    rmSync(h.launcher);
    symlinkSync(path.join(h.versions, '2.1.290'), h.launcher);
    const r = run(h);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'current', before: '2.1.290', target: TARGET });
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, '2.1.290'));
    expect(r.status).toBe(0);
  }, T);

  it('holds when a newer release has a publish time in the future', () => {
    const h = harness();
    publishTimes(h, JSON.stringify({ [OLD]: isoDaysAgo(30), [TARGET]: isoDaysAgo(10), '2.1.285': isoDaysAgo(-3) }));
    const r = run(h);
    expect(events(r, 'claude').at(-1)).toMatchObject({ status: 'held' });
    expect(events(r, 'claude').at(-1)!.message).toContain('anomaly');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('holds when a newer release has an invalid publish time', () => {
    const h = harness();
    publishTimes(h, JSON.stringify({ [OLD]: isoDaysAgo(30), [TARGET]: isoDaysAgo(10), '2.1.285': '2026-02-30T00:00:00Z' }));
    const r = run(h);
    expect(claudeStatus(r)).toBe('held');
    expect(fixtureCalls(h)).toEqual([]);
  }, T);

  it('holds when every newer release is younger than the cooldown', () => {
    const h = harness();
    publishTimes(h, JSON.stringify({ [OLD]: isoDaysAgo(30), [TARGET]: isoDaysAgo(2) }));
    const r = run(h);
    expect(claudeStatus(r)).toBe('current');
    expect(fixtureCalls(h)).toEqual([]);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);
});

describe('--check on the main path', () => {
  it('plans the update, installs nothing, exits 0 and writes a check-mode state', () => {
    const h = harness();
    const r = run(h, ['--check']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.state?.mode).toBe('check');
    expect(events(r, 'claude').map((e) => e.status)).toEqual(['drift']);
    expect(allFixtureCalls(h)).toEqual([]);
    expect(readFileSync(h.npmLog, 'utf8')).not.toMatch(/^install /m);
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
  }, T);
});

describe('native classification of the launcher target', () => {
  it('still lists plugins and MCP servers through an accepted native launcher in a normal run', () => {
    const h = harness();
    const r = run(h);
    expect(events(r, 'claude-plugins')[0]).toMatchObject({ status: 'ok' });
    // Started through the launcher link, so the fixture sees argv[0] "claude".
    expect(allFixtureCalls(h)).toContain('claude plugin list');
  }, T);

  it('lists plugins through an npm-layout launcher only when its interpreter is node', () => {
    const h = harness();
    const pkg = path.join(h.home, 'npm-global/lib/node_modules/@anthropic-ai/claude-code');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.280' }));
    const calls = path.join(h.home, 'npm-calls');
    // Launcher-first PATH: the npm bin directory precedes ~/.local/bin for the job.
    const bin = path.join(h.home, 'npm-global/bin');
    mkdirSync(bin, { recursive: true });
    writeExec(path.join(pkg, 'cli.js'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    symlinkSync(path.join(pkg, 'cli.js'), path.join(bin, 'claude'));
    const r = run(h);
    expect(events(r, 'claude-plugins')[0]).toMatchObject({ status: 'unknown' });
    expect(existsSync(calls)).toBe(false);

    // The same package with a node entry point is admitted.
    rmSync(path.join(pkg, 'cli.js'));
    writeExec(path.join(pkg, 'cli.js'),
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    const admitted = run(h);
    expect(events(admitted, 'claude-plugins')[0]).toMatchObject({ status: 'ok' });
    expect(readFileSync(calls, 'utf8')).toContain('plugin list');
  }, T);

  it('does not treat an executable shebang script inside the versions directory as native', () => {
    const h = harness();
    // Same place and name the native installer uses, but a script, not a native executable.
    const calls = path.join(h.home, 'script-calls');
    rmSync(path.join(h.versions, OLD));
    writeExec(path.join(h.versions, OLD), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\necho "${OLD} (agent CLI)"\n`);
    const r = run(h);
    const consumer = events(r, 'claude-consumer')[0]!;
    expect(consumer.status).toBe('resolved');
    expect(consumer.message).not.toContain('(native');
    expect(claudeStatus(r)).toBe('unmanaged-layout');
    // Nothing runs it: not the update path, and not the tier-2 plugin and MCP listings, which
    // only start a launcher the static classifier accepted.
    expect(existsSync(calls)).toBe(false);
    for (const probe of ['claude-plugins', 'mcp-servers']) {
      expect(events(r, probe)[0], probe).toMatchObject({ status: 'unknown' });
      expect(events(r, probe)[0]!.message).toContain('not executed');
    }
    expect(readlinkSync(h.launcher)).toBe(path.join(h.versions, OLD));
    // --check never executes it at all.
    rmSync(calls, { force: true });
    run(h, ['--check']);
    expect(existsSync(calls)).toBe(false);
  }, T);
});
