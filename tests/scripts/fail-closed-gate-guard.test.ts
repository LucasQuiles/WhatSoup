import { describe, expect, it } from 'vitest';

import { scanGateScript, scanRepoGates } from '../../scripts/fail-closed-gate-guard.ts';

describe('fail-closed-gate-guard — scanGateScript', () => {
  it('flags a success-only gate on a sentinel-captured variable (fail-open)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'code=$(curl -s -o /dev/null -w "%{http_code}" https://h/health || echo "000")',
      'if [ "$code" = "200" ]; then',
      '  echo READY',
      'fi',
    ].join('\n');
    const findings = scanGateScript('scripts/check_ready.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('fail-open-probe');
    expect(findings[0].variable).toBe('code');
    expect(findings[0].line).toBe(3);
  });

  it('does NOT flag when a fail-closed branch handles the inconclusive path', () => {
    const script = [
      '#!/usr/bin/env bash',
      'code=$(curl -s -o /dev/null -w "%{http_code}" https://h/old || echo "000")',
      'if [ "$code" = "200" ]; then',
      '  fail "old password still works"',
      'elif [ "$code" != "401" ]; then',
      '  fail "probe returned $code (expected 401); inconclusive"',
      'fi',
    ].join('\n');
    expect(scanGateScript('scripts/check_rotation.sh', script)).toHaveLength(0);
  });

  it('does NOT flag a -z inconclusive guard (Redis PONG shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'resp=$(ssh host "redis-cli PING 2>/dev/null || true")',
      'if [ -z "$resp" ]; then',
      '  fail_infra "probe inconclusive"',
      'elif [ "$resp" = "PONG" ]; then',
      '  fail_actionable "old password still works"',
      'fi',
    ].join('\n');
    expect(scanGateScript('scripts/check_redis.sh', script)).toHaveLength(0);
  });

  it('does NOT flag a script with no sentinel capture at all', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl --fail https://h/health',
      'echo done',
    ].join('\n');
    expect(scanGateScript('scripts/probe.sh', script)).toHaveLength(0);
  });

  it('still flags when an UNRELATED != branch (not on the probe var) exists', () => {
    // Regression guard: a stray `!= "prod"` must NOT suppress the probe finding;
    // suppression is per-variable (must reference $code), not file-level.
    const script = [
      '#!/usr/bin/env bash',
      'code=$(curl -s -w "%{http_code}" https://h/health || echo "000")',
      'if [ "$ENV" != "prod" ]; then exit 0; fi',
      'if [ "$code" = "200" ]; then echo ready; fi',
    ].join('\n');
    const findings = scanGateScript('scripts/check_health.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('fail-open-probe');
    expect(findings[0].variable).toBe('code');
  });

  it('does NOT flag a sentinel capture with no success gate', () => {
    const script = [
      '#!/usr/bin/env bash',
      'code=$(curl -s -w "%{http_code}" https://h || echo "000")',
      'echo "status was $code"',
    ].join('\n');
    expect(scanGateScript('scripts/diag.sh', script)).toHaveLength(0);
  });

  it('flags grep -c counters that append a second zero on no matches', () => {
    const script = [
      '#!/usr/bin/env bash',
      'count=$(printf "%s\\n" "$lines" | grep -c "needle" || echo 0)',
      'if [ "$count" -eq 0 ]; then echo clean; fi',
    ].join('\n');
    const findings = scanGateScript('console/scripts/check_design.sh', script);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('duplicate-zero-count');
    expect(findings[0].line).toBe(2);
    expect(findings[0].detail).toContain('0\\n0');
  });

  it('does NOT flag grep -c counters that preserve the emitted zero', () => {
    const script = [
      '#!/usr/bin/env bash',
      'count=$(printf "%s\\n" "$lines" | grep -c "needle" || true)',
      'count=${count:-0}',
    ].join('\n');
    expect(scanGateScript('console/scripts/check_design.sh', script)).toHaveLength(0);
  });
});

/**
 * `execution.pipeline.status-incomplete`.
 *
 * A bash pipeline exits with the status of its LAST command unless `pipefail` is set, so
 * `git push origin main | tail -5` reports success when the push failed. This is not
 * hypothetical: it happened in this repo during a push, produced `PUSH_EXIT=0` for a push
 * that had actually been rejected, and the branch was reported as landed when it was not.
 * `set -e` does NOT catch it — the pipeline "succeeded" as far as the shell is concerned.
 *
 * Only pipelines whose status is CONSUMED are flagged. A pipeline whose output is the
 * point and whose status nobody reads is not a defect, and flagging it would train people
 * to ignore the guard.
 */
describe('fail-closed-gate-guard — masked pipeline status', () => {
  it('flags a pipeline whose status is then read from $? (the real incident shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'set -e',
      'git push origin main | tail -5',
      'PUSH_EXIT=$?',
      'echo "exit=$PUSH_EXIT"',
    ].join('\n');
    const findings = scanGateScript('scripts/verify_push.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('masked-pipeline-status');
    expect(findings[0].line).toBe(3);
    expect(findings[0].detail).toContain('pipefail');
  });

  it('flags a pipeline used as an if condition when the tail cannot fail', () => {
    // `tee` exits 0 whatever the tests did, so this branch is taken on a red suite.
    const script = [
      '#!/usr/bin/env bash',
      'if npm test | tee test.log; then',
      '  echo GREEN',
      'fi',
    ].join('\n');
    const findings = scanGateScript('scripts/check_health.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('masked-pipeline-status');
    expect(findings[0].line).toBe(2);
  });

  it('does NOT flag `producer | grep -q` — that idiom already fails closed', () => {
    // The distinction is which way the pipeline fails when the HEAD dies. Here a failed
    // curl produces no output, grep finds nothing, and the condition is false. Compare
    // `... | tee`, where a failed head prints nothing and the pipeline still exits 0.
    const script = [
      '#!/usr/bin/env bash',
      'if curl -s https://h/health | grep -q ok; then',
      '  echo READY',
      'fi',
      "if ! printf '%s' \"$version\" | grep -qE '^[0-9]'; then",
      '  echo "FATAL: not a dotted version" >&2',
      'fi',
      'count=$(printf "%s" "$lines" | grep -c needle || true)',
      'rc=$?',
    ].join('\n');
    expect(scanGateScript('deploy/lib/resolve-node.sh', script)).toHaveLength(0);
  });

  it('flags a pipeline whose status is tested inline with || ', () => {
    const script = ['#!/usr/bin/env bash', 'tar czf - ./src | gzip > out.gz || fail "backup failed"'].join('\n');
    expect(scanGateScript('scripts/verify_backup.sh', script)).toHaveLength(1);
  });

  it('does NOT flag when pipefail is enabled earlier', () => {
    for (const enable of ['set -o pipefail', 'set -euo pipefail', 'set -eo pipefail']) {
      const script = ['#!/usr/bin/env bash', enable, 'git push origin main | tail -5', 'PUSH_EXIT=$?'].join('\n');
      expect(scanGateScript('scripts/verify_push.sh', script), enable).toHaveLength(0);
    }
  });

  it('DOES flag a pipeline that runs BEFORE pipefail is enabled', () => {
    // Enabling it later does not retroactively protect the earlier pipeline; a guard that
    // only asked "does the file mention pipefail" would call this clean.
    const script = [
      '#!/usr/bin/env bash',
      'git push origin main | tail -5',
      'PUSH_EXIT=$?',
      'set -o pipefail',
      'other | thing',
      'rc=$?',
    ].join('\n');
    const findings = scanGateScript('scripts/verify_push.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('does NOT flag a pipeline nobody checks the status of', () => {
    const script = ['#!/usr/bin/env bash', 'cat banner.txt | sed "s/x/y/"', 'echo done'].join('\n');
    expect(scanGateScript('scripts/print_banner.sh', script)).toHaveLength(0);
  });

  it('does NOT mistake logical || or && for a pipeline', () => {
    const script = ['#!/usr/bin/env bash', 'command -v node || fail "no node"', 'rc=$?'].join('\n');
    expect(scanGateScript('scripts/check_node.sh', script)).toHaveLength(0);
  });

  it('does NOT mistake a pipe inside quotes for a pipeline', () => {
    // `grep -E "a|b"` is an alternation, not a pipeline. Flagging it would be noise, and
    // noise is how a guard gets disabled.
    const script = [
      '#!/usr/bin/env bash',
      'if grep -Eq "alpha|beta" "$file"; then',
      '  echo matched',
      'fi',
      "awk '{print $1}' f | true",
    ].join('\n');
    expect(scanGateScript('scripts/check_names.sh', script)).toHaveLength(0);
  });

  it('does NOT flag commented-out pipelines', () => {
    const script = ['#!/usr/bin/env bash', '# git push origin main | tail -5', '# PUSH_EXIT=$?', 'echo ok'].join('\n');
    expect(scanGateScript('scripts/verify_push.sh', script)).toHaveLength(0);
  });
});

describe('fail-closed-gate-guard — repo scan (regression trap)', () => {
  it('finds no fail-open gate or duplicate-zero counter shapes in committed shell gates', () => {
    // Clean HEAD must pass; this arms the trap for future regressions.
    const findings = scanRepoGates(process.cwd());
    expect(findings).toEqual([]);
  });
});
