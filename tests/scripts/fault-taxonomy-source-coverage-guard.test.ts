// Black-box tests for scripts/fault-taxonomy-source-coverage-guard.ts (#2147).
// Fixture trees carry their own registry + baseline, so every contract edge
// (growth, stale debt both ways, unclaimed dynamic sites, stale claims) is
// driven without touching the live files; one live-tree run proves the real
// repo currently satisfies the guard.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO_ROOT, 'scripts/fault-taxonomy-source-coverage-guard.ts');

interface Fixture {
  registry?: Record<string, unknown>;
  baseline?: Record<string, unknown>;
  srcFiles?: Record<string, string>;
}

function run(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', GUARD], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function makeFixture(fx: Fixture): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ftx-coverage-'));
  mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'deploy/scripts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src/lib/fault-taxonomy-registry.json'),
    JSON.stringify({ sourceDispositions: {}, ...fx.registry }),
  );
  writeFileSync(
    path.join(dir, 'scripts/fault-taxonomy-source-coverage-baseline.json'),
    JSON.stringify({ schemaVersion: 1, entries: [], dynamicClaims: {}, ...fx.baseline }),
  );
  for (const [rel, body] of Object.entries(fx.srcFiles ?? {})) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

const REGISTERED = {
  sourceDispositions: {
    known_source: { disposition: 'x', owner: 'src/a.ts', test: 'tests/a.test.ts' },
  },
};

describe('fault-taxonomy source-coverage guard (#2147)', () => {
  it('passes on the live tree', () => {
    const res = run(REPO_ROOT);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('fault-taxonomy source-coverage guard passed');
  });

  it('fails on a newly emitted source missing from registry and baseline (growth)', () => {
    const dir = makeFixture({
      registry: REGISTERED,
      srcFiles: {
        'src/foo.ts': "emitAlertChecked(instance, 'brand_new_source', 'summary', 'evidence');\n",
      },
    });
    try {
      const res = run(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unregistered-source-growth: 'brand_new_source'");
      expect(res.stderr).toContain('src/foo.ts:1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds standing debt without failing, and reports the debt count', () => {
    const dir = makeFixture({
      registry: REGISTERED,
      baseline: {
        entries: [{ source: 'debt_source', owner: 'src/foo.ts', status: 'debt', reason: 'r' }],
      },
      srcFiles: {
        'src/foo.ts': "emitAlert(instance, 'debt_source', 's', 'e');\n",
      },
    });
    try {
      const res = run(dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('1 debt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails stale debt whose source became registered', () => {
    const dir = makeFixture({
      registry: {
        sourceDispositions: {
          promoted_source: { disposition: 'x', owner: 'o', test: 't' },
        },
      },
      baseline: {
        entries: [{ source: 'promoted_source', owner: 'src/foo.ts', status: 'debt', reason: 'r' }],
      },
      srcFiles: {
        'src/foo.ts': "emitAlert(instance, 'promoted_source', 's', 'e');\n",
      },
    });
    try {
      const res = run(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("stale-debt: baseline entry 'promoted_source' is now registered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails stale debt whose source is no longer emitted', () => {
    const dir = makeFixture({
      registry: REGISTERED,
      baseline: {
        entries: [{ source: 'ghost_source', owner: 'src/foo.ts', status: 'debt', reason: 'r' }],
      },
      srcFiles: { 'src/foo.ts': '// nothing emitted here\n' },
    });
    try {
      const res = run(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("stale-debt: baseline entry 'ghost_source' is no longer emitted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails an unresolved emit site not claimed as dynamic', () => {
    const dir = makeFixture({
      registry: REGISTERED,
      srcFiles: {
        'src/foo.ts': 'emitAlertChecked(instance, computedSource, "s", "e");\n',
      },
    });
    try {
      const res = run(dir);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('unresolved-source: src/foo.ts:1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a claimed dynamic site and fails a claim that is neither registered nor debt', () => {
    const claimedOk = makeFixture({
      registry: REGISTERED,
      baseline: {
        entries: [{ source: 'family_source', owner: 'src/foo.ts', status: 'debt', reason: 'r' }],
        dynamicClaims: { family_source: 'src/foo.ts' },
      },
      srcFiles: {
        'src/foo.ts': 'emitAlertChecked(instance, computedSource, "s", "e");\n',
      },
    });
    const claimStale = makeFixture({
      registry: REGISTERED,
      baseline: {
        dynamicClaims: { phantom_source: 'src/foo.ts' },
      },
      srcFiles: { 'src/foo.ts': '// no emits\n' },
    });
    try {
      const ok = run(claimedOk);
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);

      const stale = run(claimStale);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("stale-claim: dynamic source 'phantom_source'");
    } finally {
      rmSync(claimedOk, { recursive: true, force: true });
      rmSync(claimStale, { recursive: true, force: true });
    }
  });

  it('resolves same-file const indirection and ignores commented call text', () => {
    const dir = makeFixture({
      registry: {
        sourceDispositions: {
          'const-resolved-source': { disposition: 'x', owner: 'o', test: 't' },
        },
      },
      srcFiles: {
        'src/foo.ts': [
          "const MY_SOURCE = 'const-resolved-source';",
          '// emitAlertChecked (mentioned in prose) must not count as a call site',
          "emitAlertChecked(instance, MY_SOURCE, 's', 'e');",
          '',
        ].join('\n'),
      },
    });
    try {
      const res = run(dir);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('1 literal source(s)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
