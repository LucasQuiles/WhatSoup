/**
 * Guard-command resolver — the pure rules, including the red proof.
 *
 * The one that matters is `throws on a wrapper-only command`. That is the defect that produced
 * a false-green vacuity sweep this session: a regex that grabbed the first script-looking token
 * returned `scripts/run-with-pinned-node.sh` (the pinned-node WRAPPER) for every guard, so the
 * sweep spawned the wrapper and examined nothing. A resolver that hands back the wrapper is
 * worse than useless here; it must fail loud.
 *
 * Cases are taken from the ACTUAL shapes in package.json (wrapped-ts, direct-sh, alias,
 * env-prefixed alias, `gh api` network, `npm run`-composite, `$PWD`-interpolated) so the rules
 * are pinned to real commands, not invented ones.
 */
import { describe, expect, it } from 'vitest';

import {
  WrapperResolutionError,
  assertRealEntrypoint,
  resolveGuardCommand,
} from '../../scripts/lib/guard-command-resolver.ts';

describe('resolveGuardCommand — entrypoints', () => {
  it('resolves a wrapped .ts guard to the guard, NOT the wrapper', () => {
    const r = resolveGuardCommand('bash scripts/run-with-pinned-node.sh scripts/check-insecure-tempfile.ts');
    expect(r).toEqual({
      kind: 'entrypoint',
      script: 'scripts/check-insecure-tempfile.ts',
      interpreter: 'node-strip',
      trailingArgs: [],
    });
  });

  it('keeps literal trailing args after the entrypoint', () => {
    const r = resolveGuardCommand('bash scripts/run-with-pinned-node.sh scripts/work-index.ts --check');
    expect(r).toMatchObject({ kind: 'entrypoint', script: 'scripts/work-index.ts', trailingArgs: ['--check'] });
  });

  it('resolves a direct .sh guard with bash as the interpreter', () => {
    const r = resolveGuardCommand('bash scripts/check-unit-drift.sh');
    expect(r).toEqual({ kind: 'entrypoint', script: 'scripts/check-unit-drift.sh', interpreter: 'bash', trailingArgs: [] });
  });

  it('resolves an ABSOLUTE entrypoint over the wrapper (used by the vacuity self-test)', () => {
    const r = resolveGuardCommand('bash scripts/run-with-pinned-node.sh /tmp/synthetic-guard-x/vacuous.mjs');
    expect(r).toEqual({
      kind: 'entrypoint',
      script: '/tmp/synthetic-guard-x/vacuous.mjs',
      interpreter: 'node',
      trailingArgs: [],
    });
  });
});

describe('resolveGuardCommand — skips, each with a reason', () => {
  it('marks a `gh api` command as network (not offline-judgeable)', () => {
    const r = resolveGuardCommand(
      'gh api repos/LucasQuiles/WhatSoup/branches/main/protection | bash scripts/run-with-pinned-node.sh scripts/branch-protection-drift-check.ts --observed -',
    );
    expect(r).toMatchObject({ kind: 'skip', reason: 'network' });
  });

  it('marks an `npm run guard:*` alias with the base guard it delegates to', () => {
    expect(resolveGuardCommand('npm run guard:publication -- --all')).toEqual({
      kind: 'skip',
      reason: 'alias',
      detail: 'guard:publication',
    });
  });

  it('sees through an env-var prefix to the alias', () => {
    expect(resolveGuardCommand('WHATSOUP_REQUIRE_TEST_INTEGRITY=1 npm run guard:test-integrity')).toMatchObject({
      kind: 'skip',
      reason: 'alias',
      detail: 'guard:test-integrity',
    });
  });

  it('marks a non-guard `npm run` delegate as composite', () => {
    expect(resolveGuardCommand('npm run drift:classify -- --self-check')).toMatchObject({
      kind: 'skip',
      reason: 'composite',
    });
  });

  it('marks a `$PWD`-interpolated deploy verify as composite (not a literal invocation)', () => {
    expect(resolveGuardCommand('bash deploy/scripts/whatsoup-bot-errors-deploy.sh verify "$PWD"')).toMatchObject({
      kind: 'skip',
      reason: 'composite',
    });
  });

  it('marks a deploy preflight with no scripts/ entrypoint as composite', () => {
    expect(resolveGuardCommand('bash deploy/preflight-check.sh .')).toMatchObject({
      kind: 'skip',
      reason: 'composite',
    });
  });
});

describe('resolveGuardCommand — the wrapper defect is made loud', () => {
  it('THROWS when the only script token is a pinned-node wrapper', () => {
    // This is the line-2755 bug: a resolver that returned the wrapper here spawned node on a
    // shell script and "examined nothing". Refusing to return it is the whole point.
    expect(() => resolveGuardCommand('bash scripts/run-with-pinned-node.sh')).toThrow(WrapperResolutionError);
  });

  it('THROWS for the npm wrapper too', () => {
    expect(() => resolveGuardCommand('bash scripts/run-with-pinned-npm.sh')).toThrow(WrapperResolutionError);
  });

  it('assertRealEntrypoint re-guards the wrapper at the spawn boundary', () => {
    const wrapperEntry = {
      kind: 'entrypoint' as const,
      script: 'scripts/run-with-pinned-node.sh',
      interpreter: 'bash' as const,
      trailingArgs: [],
    };
    expect(() => assertRealEntrypoint(wrapperEntry, '<synthetic>')).toThrow(WrapperResolutionError);
  });

  it('assertRealEntrypoint rejects a skip masquerading as usable', () => {
    const skip = resolveGuardCommand('npm run guard:publication -- --all');
    expect(() => assertRealEntrypoint(skip, 'guard:publication:all')).toThrow(/expected an entrypoint/);
  });
});
