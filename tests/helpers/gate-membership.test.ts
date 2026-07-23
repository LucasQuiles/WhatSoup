/**
 * The helper two protection suites depend on, tested against synthetic inputs.
 *
 * Both callers assert "no unreachable checks", so on a healthy repo they only ever exercise
 * the reachable branches — the NEGATIVE path is what actually protects them, and on a green
 * tree it never runs. These tests drive it directly with fixture inputs so a regression in
 * `scriptReachability` cannot quietly turn both suites into unconditional passes.
 */
import { describe, expect, it } from 'vitest';

import {
  CI_EXEMPT_PUSH_GATE_GUARDS,
  backstopReachability,
  namedInCi,
  pushGateGuards,
  runsFullSuite,
  scriptReachability,
  type GateInputs,
} from './gate-membership.ts';

const inputs = (overrides: Partial<GateInputs> = {}): GateInputs => ({
  scripts: {
    'verify:push:branch': 'npm run guard:alpha && npm run guard:ssot-patterns && npm test',
    'guard:alpha': 'echo alpha',
    'guard:ssot-patterns': 'echo ssot',
  },
  // Models quality.yml: a named guard step AND the full suite.
  qualityWorkflow:
    '      - name: Alpha\n        run: npm run guard:alpha\n' +
    '      - name: Tests\n        run: npm run coverage:check\n',
  // Models tag-release-gate.yml: discrete guard steps, NO unit suite.
  tagReleaseWorkflow: '      - name: Alpha\n        run: npm run guard:alpha\n',
  ...overrides,
});

describe('pushGateGuards', () => {
  it('extracts, dedupes and sorts the guard scripts the push gate invokes', () => {
    expect(pushGateGuards(inputs().scripts)).toEqual(['guard:alpha', 'guard:ssot-patterns']);
  });

  it('returns empty when verify:push:branch is absent rather than throwing', () => {
    expect(pushGateGuards({})).toEqual([]);
  });

  it('does not pick up non-guard npm scripts from the chain', () => {
    expect(pushGateGuards(inputs().scripts)).not.toContain('npm');
  });
});

describe('namedInCi', () => {
  it('matches a guard that has a named step', () => {
    expect(namedInCi('guard:alpha', inputs().qualityWorkflow)).toBe(true);
  });

  it('does not match a guard that has none', () => {
    expect(namedInCi('guard:ssot-patterns', inputs().qualityWorkflow)).toBe(false);
  });

  it('does NOT let a longer-named sibling satisfy a shorter guard', () => {
    // The regression the negative lookahead exists for: `npm run guard:repo:commit-authors`
    // in the workflow must not make bare `guard:repo` report as covered, or a guard absent
    // from CI reads as present because a different guard happens to run.
    const wf = '        run: npm run guard:repo:commit-authors\n';
    expect(namedInCi('guard:repo:commit-authors', wf)).toBe(true);
    expect(namedInCi('guard:repo', wf)).toBe(false);
  });
});

describe('scriptReachability', () => {
  it('reports ci-step for a guard named in the workflow', () => {
    const r = scriptReachability('guard:alpha', inputs());
    expect(r).toMatchObject({ reachable: true, via: 'ci-step' });
  });

  it('reports push-gate-exemption for an exempted guard the push gate runs', () => {
    const r = scriptReachability('guard:ssot-patterns', inputs());
    expect(r).toMatchObject({ reachable: true, via: 'push-gate-exemption' });
    expect(r.detail).toContain('tests/scripts/ssot-pattern-guard.test.ts');
  });

  it('reports UNREACHABLE for a push-gate guard with no CI step and no exemption', () => {
    // The branch that carries the whole protection. A guard here runs only from the
    // advisory husky hook, so any server-side merge bypasses it.
    const gate = inputs({
      scripts: {
        'verify:push:branch': 'npm run guard:lonely',
        'guard:lonely': 'echo lonely',
      },
    });
    const r = scriptReachability('guard:lonely', gate);
    expect(r.reachable).toBe(false);
    expect(r.via).toBe('none');
    // The message must NAME the path it is talking about — an unreachability report that
    // does not say which gate is the ambiguity this helper was made path-aware to remove.
    expect(r.detail).toMatch(/pull-request/);
    expect(r.detail).toMatch(/does not run it/);
  });

  it('does NOT grant an exemption to a guard the push gate does not actually run', () => {
    // An exemption is a claim about a guard in the gate. If the guard left the gate, the
    // entry is stale and must not keep conferring reachability.
    const gate = inputs({ scripts: { 'verify:push:branch': 'npm run guard:alpha' } });
    expect(scriptReachability('guard:ssot-patterns', gate).reachable).toBe(false);
  });

  it('reports UNREACHABLE for a script that appears nowhere at all', () => {
    expect(scriptReachability('guard:does-not-exist', inputs()).reachable).toBe(false);
  });
});

describe('per-path reachability — the two gates are NOT equivalent', () => {
  it('runsFullSuite is derived from the workflow text, not hardcoded per path', () => {
    expect(runsFullSuite('pull-request', inputs())).toBe(true);
    expect(runsFullSuite('tag-release', inputs())).toBe(false);
    // If the tag gate ever gains the suite, the answer must follow the bytes.
    const upgraded = inputs({ tagReleaseWorkflow: 'run: npm run coverage:check\n' });
    expect(runsFullSuite('tag-release', upgraded)).toBe(true);
  });

  it('an exempted push-gate guard is reachable on pull-request but NOT on tag-release', () => {
    // The whole point of making this path-aware. The exemption rests on a live-tree test
    // inside the full suite; the tag gate never runs that suite, so the guard is genuinely
    // unreachable there while remaining reachable on the PR path.
    expect(scriptReachability('guard:ssot-patterns', inputs(), 'pull-request').reachable).toBe(true);
    const tag = scriptReachability('guard:ssot-patterns', inputs(), 'tag-release');
    expect(tag.reachable).toBe(false);
    expect(tag.detail).toMatch(/does not run the full suite/);
  });

  it('a guard named in BOTH workflows is reachable on both', () => {
    expect(scriptReachability('guard:alpha', inputs(), 'pull-request').reachable).toBe(true);
    expect(scriptReachability('guard:alpha', inputs(), 'tag-release').reachable).toBe(true);
  });

  it('defaults to the pull-request path when none is given', () => {
    expect(scriptReachability('guard:ssot-patterns', inputs())).toEqual(
      scriptReachability('guard:ssot-patterns', inputs(), 'pull-request'),
    );
  });

  it('a test-file backstop tracks runsFullSuite on each path', () => {
    // Test-file backstops were handled inline in the calling suite before, which is how the
    // npm-script half became path-aware while this half silently did not.
    const entry = 'tests/scripts/anything.test.ts';
    expect(backstopReachability(entry, inputs(), 'pull-request').reachable).toBe(true);
    const tag = backstopReachability(entry, inputs(), 'tag-release');
    expect(tag.reachable).toBe(false);
    expect(tag.detail).toMatch(/does not run the full suite/);
  });

  it('backstopReachability routes npm scripts to scriptReachability unchanged', () => {
    for (const path of ['pull-request', 'tag-release'] as const) {
      expect(backstopReachability('guard:ssot-patterns', inputs(), path)).toEqual(
        scriptReachability('guard:ssot-patterns', inputs(), path),
      );
    }
  });
});

describe('CI_EXEMPT_PUSH_GATE_GUARDS', () => {
  it('every entry states a reason, and backedBy is a path or an explicit null', () => {
    for (const [guard, entry] of Object.entries(CI_EXEMPT_PUSH_GATE_GUARDS)) {
      expect(entry.why.length, `${guard} needs a substantive reason`).toBeGreaterThan(30);
      if (entry.backedBy !== null) {
        expect(entry.backedBy, `${guard} backedBy must be a repo-relative test path`).toMatch(
          /^tests\/.*\.test\.ts$/,
        );
      }
    }
  });
});
