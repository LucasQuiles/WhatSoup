/**
 * #3221 Debt 3 (A-08): the OWNER-APPROVED media-retention policy artifact
 * `policy/media-retention.json` and its fail-closed loader/validator. The
 * owner ruled a 90-day retention horizon (2026-08-28); an enabled
 * capability-obligation config must comply with the shipped artifact — a
 * horizon LONGER than the owner approved, or a policy-version mismatch, is a
 * config defect refused at load, upstream of every DM/group media drain.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MEDIA_RETENTION_POLICY_REPO_PATH,
  assertRetentionConfigCompliesWithPolicy,
  loadMediaRetentionPolicy,
  parseMediaRetentionPolicy,
  type MediaRetentionPolicy,
} from '../../src/core/media-retention-policy.ts';

const VALID_POLICY = {
  policyVersion: 'media-retention/2026-08-28',
  retentionHorizonDays: 90,
  approvedBy: 'owner',
  approvedAt: '2026-08-28',
  appliesTo: 'capability-obligation retained media (A-08)',
};

let tmpDirs: string[] = [];

function tmpPolicyFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-retention-policy-'));
  tmpDirs.push(dir);
  const path = join(dir, 'media-retention.json');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('the shipped owner-approved artifact (policy/media-retention.json)', () => {
  it('exists in the release and carries the owner-ruled 90-day horizon', () => {
    const policy = loadMediaRetentionPolicy();
    expect(policy.retentionHorizonDays).toBe(90);
    expect(policy.policyVersion.length).toBeGreaterThan(0);
    expect(policy.approvedBy.length).toBeGreaterThan(0);
    expect(policy.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the default load path points at the repo policy/ artifact', () => {
    expect(MEDIA_RETENTION_POLICY_REPO_PATH.endsWith('policy/media-retention.json')).toBe(true);
  });
});

describe('loadMediaRetentionPolicy — fail-closed', () => {
  it('throws when the artifact is absent (never a silent default horizon)', () => {
    expect(() => loadMediaRetentionPolicy('/nonexistent/media-retention.json')).toThrow(/media-retention/i);
  });

  it('throws on malformed JSON', () => {
    expect(() => loadMediaRetentionPolicy(tmpPolicyFile('{nope'))).toThrow();
  });

  it('loads a valid artifact from an explicit path', () => {
    const policy = loadMediaRetentionPolicy(tmpPolicyFile(JSON.stringify(VALID_POLICY)));
    expect(policy.retentionHorizonDays).toBe(90);
  });
});

describe('parseMediaRetentionPolicy — the A-08 bounds are unrepresentable-if-wrong', () => {
  it('accepts the valid shape', () => {
    expect(parseMediaRetentionPolicy(VALID_POLICY).policyVersion).toBe('media-retention/2026-08-28');
  });

  it('rejects an unbounded, zero, or missing horizon', () => {
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, retentionHorizonDays: 0 })).toThrow();
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, retentionHorizonDays: 366 })).toThrow();
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, retentionHorizonDays: undefined })).toThrow();
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, retentionHorizonDays: 90.5 })).toThrow();
  });

  it('rejects a missing version / approver and unknown keys (strict shape)', () => {
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, policyVersion: '' })).toThrow();
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, approvedBy: '' })).toThrow();
    expect(() => parseMediaRetentionPolicy({ ...VALID_POLICY, extra: true })).toThrow();
    expect(() => parseMediaRetentionPolicy(null)).toThrow();
    expect(() => parseMediaRetentionPolicy('90')).toThrow();
  });
});

describe('assertRetentionConfigCompliesWithPolicy — the drain-side verification', () => {
  const policy: MediaRetentionPolicy = parseMediaRetentionPolicy(VALID_POLICY);

  it('a config horizon LONGER than the owner approved is refused', () => {
    expect(() =>
      assertRetentionConfigCompliesWithPolicy(
        { retentionHorizonDays: 91, retentionPolicyVersion: policy.policyVersion },
        policy,
      ),
    ).toThrow(/91[\s\S]*90|90[\s\S]*91/);
  });

  it('a policy-version mismatch is refused (the config must name the ratified artifact)', () => {
    expect(() =>
      assertRetentionConfigCompliesWithPolicy(
        { retentionHorizonDays: 30, retentionPolicyVersion: 'policy/1' },
        policy,
      ),
    ).toThrow(/version/i);
  });

  it('an equal or stricter horizon under the ratified version complies', () => {
    expect(() =>
      assertRetentionConfigCompliesWithPolicy(
        { retentionHorizonDays: 90, retentionPolicyVersion: policy.policyVersion },
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      assertRetentionConfigCompliesWithPolicy(
        { retentionHorizonDays: 7, retentionPolicyVersion: policy.policyVersion },
        policy,
      ),
    ).not.toThrow();
  });
});
