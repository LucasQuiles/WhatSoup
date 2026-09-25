/**
 * #3221 Debt 4 (config-contract half, owner-ratified as specced): the free-form
 * `execution.command` argv is REPLACED by the typed
 * `{ interpreter, resolverArtifactPath, args }` struct, so the execution shape
 * is unrepresentable-if-wrong AT THE SCHEMA — the artifact is always the
 * executing token by construction, direct-mode flag/positional code smuggling
 * (round-21 finding 2) is refused at LOAD, and the runtime keeps consuming the
 * DERIVED `command`/`interpreted` pair, so the canonical execution identity
 * (and therefore every attested composite digest) is unchanged for an
 * equivalent declaration.
 */
import { describe, expect, it } from 'vitest';

import { parseCapabilityObligationsOptions } from '../../src/core/capability-contract.ts';
import { canonicalExecutionIdentity } from '../../src/core/capability-resolver-artifact.ts';

const CONTRACT_RAW = {
  version: 'typed-exec/1',
  rules: [
    { id: 'watch', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' },
  ],
};

const BASE = {
  enabled: true,
  contract: CONTRACT_RAW,
  mediaRoot: '/var/obligation-media',
  retentionPolicyVersion: 'media-retention/2026-08-28',
  retentionHorizonDays: 90,
  attestation: {
    skillName: 'watch',
    skillVersion: '1.0.0',
    skillDigest: 'digest-1',
    resolverDigest: 'resolver-1',
    dependencyVersions: {},
    probeVersion: 'probe/1',
    canaryId: 'canary-1',
  },
};

const TYPED_INTERPRETED = {
  interpreter: '/usr/bin/node',
  resolverArtifactPath: '/opt/watch/resolver.cjs',
  args: ['{source}'],
  timeoutMs: 30_000,
  minOutputBytes: 8,
};

const TYPED_DIRECT = {
  interpreter: null,
  resolverArtifactPath: '/opt/watch/resolver',
  args: ['{source}'],
  timeoutMs: 30_000,
  minOutputBytes: 8,
};

function parseExecution(execution: unknown) {
  const options = parseCapabilityObligationsOptions({ ...BASE, execution });
  if (options === null) throw new Error('expected an enabled parse');
  return options.execution;
}

describe('typed execution struct — accepted shapes and the derived argv', () => {
  it('interpreted mode derives command = [interpreter, artifact, ...args] and interpreted = true', () => {
    const execution = parseExecution(TYPED_INTERPRETED);
    expect(execution.command).toEqual(['/usr/bin/node', '/opt/watch/resolver.cjs', '{source}']);
    expect(execution.interpreted).toBe(true);
    expect(execution.resolverArtifactPath).toBe('/opt/watch/resolver.cjs');
  });

  it('direct mode (interpreter: null) derives command = [artifact, ...args] and interpreted = false', () => {
    const execution = parseExecution(TYPED_DIRECT);
    expect(execution.command).toEqual(['/opt/watch/resolver', '{source}']);
    expect(execution.interpreted).toBe(false);
  });

  it('interpreted-mode args may include script flags (they follow the pinned artifact)', () => {
    const execution = parseExecution({ ...TYPED_INTERPRETED, args: ['--fetch', '{source}'] });
    expect(execution.command).toEqual(['/usr/bin/node', '/opt/watch/resolver.cjs', '--fetch', '{source}']);
  });

  it('the derived shape canonicalizes IDENTICALLY to the equivalent free-form declaration (no digest drift)', () => {
    const execution = parseExecution(TYPED_INTERPRETED);
    expect(canonicalExecutionIdentity(execution)).toBe(
      canonicalExecutionIdentity({
        command: ['/usr/bin/node', '/opt/watch/resolver.cjs', '{source}'],
        interpreted: true,
        resolverArtifactPath: '/opt/watch/resolver.cjs',
        timeoutMs: 30_000,
        minOutputBytes: 8,
      }),
    );
  });
});

describe('typed execution struct — the legacy free-form argv is unrepresentable', () => {
  it('a legacy command/interpreted body is REFUSED at load (breaking change, owner-ratified)', () => {
    expect(() =>
      parseExecution({
        command: ['/usr/bin/node', '/opt/watch/resolver.cjs', '{source}'],
        timeoutMs: 30_000,
        minOutputBytes: 8,
        resolverArtifactPath: '/opt/watch/resolver.cjs',
        interpreted: true,
      }),
    ).toThrow();
  });

  it('the interpreter KEY is required — mode is declared, never guessed (deny-by-default)', () => {
    const { interpreter: _omitted, ...withoutInterpreter } = TYPED_INTERPRETED;
    expect(() => parseExecution(withoutInterpreter)).toThrow();
  });

  it('args are required and each must be non-empty', () => {
    const { args: _omitted, ...withoutArgs } = TYPED_INTERPRETED;
    expect(() => parseExecution(withoutArgs)).toThrow();
    expect(() => parseExecution({ ...TYPED_INTERPRETED, args: ['{source}', ''] })).toThrow();
  });

  it('resolverArtifactPath is required and non-empty', () => {
    expect(() => parseExecution({ ...TYPED_INTERPRETED, resolverArtifactPath: '' })).toThrow();
    const { resolverArtifactPath: _omitted, ...withoutArtifact } = TYPED_INTERPRETED;
    expect(() => parseExecution(withoutArtifact)).toThrow();
  });
});

describe('typed execution struct — round-20/21 load-time refusals carried forward', () => {
  it('a bare $PATH interpreter name is unpinnable and refused', () => {
    expect(() => parseExecution({ ...TYPED_INTERPRETED, interpreter: 'node' })).toThrow(/PATH|\//);
  });

  it('a flag as the interpreter is refused', () => {
    expect(() => parseExecution({ ...TYPED_INTERPRETED, interpreter: '-e/x' })).toThrow();
  });

  it("args must reference the '{source}' placeholder somewhere", () => {
    expect(() => parseExecution({ ...TYPED_INTERPRETED, args: ['--json'] })).toThrow(/\{source\}/);
    expect(() => parseExecution({ ...TYPED_DIRECT, args: [] })).toThrow(/\{source\}/);
  });

  it('direct mode refuses FLAG args at load (round-21 finding 2, now structural at the schema)', () => {
    expect(() => parseExecution({ ...TYPED_DIRECT, args: ['-c', '{source}'] })).toThrow();
    expect(() => parseExecution({ ...TYPED_DIRECT, args: ['--eval={source}'] })).toThrow();
  });

  it('direct mode refuses bare non-{source} positionals at load', () => {
    expect(() => parseExecution({ ...TYPED_DIRECT, args: ['{source}', '/opt/other/script'] })).toThrow();
  });
});
