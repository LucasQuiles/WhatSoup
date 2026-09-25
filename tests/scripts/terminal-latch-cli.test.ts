import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTerminalLatchCli } from '../../scripts/terminal-latch-cli.ts';
import { readTerminalLatchJournal } from '../../src/transport/terminal-latch.ts';
import { computeCredentialTreeDigest } from '../../src/transport/auth-generation-v2.ts';

let root: string;
let stateRoot: string;
let revokedTree: string;
let out: string[];
let err: string[];

const AT = '2026-08-18T12:00:00.000Z';

function cli(args: string[]): number {
  out = [];
  err = [];
  return runTerminalLatchCli(args, {
    stdout: line => out.push(line),
    stderr: line => err.push(line),
  });
}

function outJson(): any {
  return JSON.parse(out.join('\n'));
}

function applyCreate(extra: string[] = []): number {
  return cli([
    'apply-create',
    '--state-root', stateRoot,
    '--scope', 'scope:line-a-wa',
    '--revoked-tree', revokedTree,
    '--reason', 'serverside_logout_irreversible',
    '--evidence-digest', 'f'.repeat(64),
    '--authorization-id', 'owner-auth-0001',
    '--operation-id', 'op-create-0001',
    '--expected-revision', '0',
    '--at', AT,
    ...extra,
  ]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'latch-cli-test-'));
  stateRoot = join(root, 'state');
  revokedTree = join(root, 'revoked-auth');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(revokedTree, { recursive: true });
  writeFileSync(join(revokedTree, 'creds.json'), '{"me":{"id":"revoked"}}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('terminal-latch-cli inspect', () => {
  it('reports a missing journal', () => {
    expect(cli(['inspect', '--state-root', stateRoot])).toBe(0);
    expect(outJson()).toEqual(
      expect.objectContaining({ state: { status: 'missing', revision: 0 } }),
    );
  });
});

describe('terminal-latch-cli plan-create / apply-create', () => {
  it('plan-create prints the transition without writing anything', () => {
    const code = cli([
      'plan-create',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--revoked-tree', revokedTree,
      '--reason', 'serverside_logout_irreversible',
      '--evidence-digest', 'f'.repeat(64),
      '--at', AT,
    ]);
    expect(code).toBe(0);
    const digest = computeCredentialTreeDigest(revokedTree);
    if (!digest.ok) throw new Error('digest fixture failed');
    expect(outJson()).toEqual(
      expect.objectContaining({
        plan: expect.objectContaining({
          kind: 'latch_created',
          revision: 1,
          expectedPriorRevision: 0,
          latch: expect.objectContaining({
            latchedCredentialTreeDigest: digest.digest,
          }),
        }),
      }),
    );
    expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'missing', revision: 0 });
  });

  it('apply-create appends an active latch bound to the revoked tree digest', () => {
    expect(applyCreate()).toBe(0);
    const state = readTerminalLatchJournal(stateRoot);
    if (state.status !== 'active') throw new Error(`expected active, got ${state.status}`);
    const digest = computeCredentialTreeDigest(revokedTree);
    if (!digest.ok) throw new Error('digest fixture failed');
    expect(state.latch.latchedCredentialTreeDigest).toBe(digest.digest);
    expect(state.revision).toBe(1);
  });

  it('apply-create refuses without authorization id, operation id, or expected revision', () => {
    for (const missing of ['--authorization-id', '--operation-id', '--expected-revision']) {
      const args = [
        'apply-create',
        '--state-root', stateRoot,
        '--scope', 'scope:line-a-wa',
        '--revoked-tree', revokedTree,
        '--reason', 'serverside_logout_irreversible',
        '--evidence-digest', 'f'.repeat(64),
        '--authorization-id', 'owner-auth-0001',
        '--operation-id', 'op-create-0001',
        '--expected-revision', '0',
        '--at', AT,
      ];
      const at = args.indexOf(missing);
      args.splice(at, 2);
      expect(cli(args)).toBe(2);
      expect(readTerminalLatchJournal(stateRoot)).toEqual({ status: 'missing', revision: 0 });
    }
  });

  it('apply-create with a stale expected revision refuses with the journal refusal', () => {
    expect(applyCreate()).toBe(0);
    const code = cli([
      'apply-create',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--revoked-tree', revokedTree,
      '--reason', 'serverside_logout_irreversible',
      '--evidence-digest', 'f'.repeat(64),
      '--authorization-id', 'owner-auth-0002',
      '--operation-id', 'op-create-0002',
      '--expected-revision', '0',
      '--at', AT,
    ]);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('revision_conflict');
  });

  it('apply-create replaying an operation id refuses', () => {
    expect(applyCreate()).toBe(0);
    // release so a second create would otherwise be legal
    expect(cli([
      'apply-release',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--owner-authorization-id', 'owner-auth-0009',
      '--operation-id', 'op-release-0001',
      '--expected-revision', '1',
      '--at', AT,
    ])).toBe(0);
    const code = cli([
      'apply-create',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--revoked-tree', revokedTree,
      '--reason', 'serverside_logout_irreversible',
      '--evidence-digest', 'f'.repeat(64),
      '--authorization-id', 'owner-auth-0003',
      '--operation-id', 'op-create-0001',
      '--expected-revision', '2',
      '--at', AT,
    ]);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('operation_replayed');
  });
});

describe('terminal-latch-cli plan-release / apply-release', () => {
  it('plan-release prints the transition; apply-release records the owner authorization', () => {
    expect(applyCreate()).toBe(0);
    expect(cli([
      'plan-release',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--at', AT,
    ])).toBe(0);
    expect(outJson().plan.kind).toBe('owner_released');
    expect(readTerminalLatchJournal(stateRoot).status).toBe('active');

    expect(cli([
      'apply-release',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--owner-authorization-id', 'owner-auth-0009',
      '--operation-id', 'op-release-0001',
      '--expected-revision', '1',
      '--at', AT,
    ])).toBe(0);
    const state = readTerminalLatchJournal(stateRoot);
    expect(state).toEqual(
      expect.objectContaining({ status: 'released', ownerAuthorizationId: 'owner-auth-0009' }),
    );
  });

  it('apply-release refuses without an owner authorization id', () => {
    expect(applyCreate()).toBe(0);
    expect(cli([
      'apply-release',
      '--state-root', stateRoot,
      '--scope', 'scope:line-a-wa',
      '--operation-id', 'op-release-0001',
      '--expected-revision', '1',
      '--at', AT,
    ])).toBe(2);
    expect(readTerminalLatchJournal(stateRoot).status).toBe('active');
  });

  it('unknown commands and unknown flags refuse with usage', () => {
    expect(cli(['destroy-latch', '--state-root', stateRoot])).toBe(2);
    expect(cli(['inspect', '--state-root', stateRoot, '--force'])).toBe(2);
  });
});
