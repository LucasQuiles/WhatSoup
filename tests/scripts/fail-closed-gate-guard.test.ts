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

describe('fail-closed-gate-guard — repo scan (regression trap)', () => {
  it('finds no fail-open gate or duplicate-zero counter shapes in committed shell gates', () => {
    // Clean HEAD must pass; this arms the trap for future regressions.
    const findings = scanRepoGates(process.cwd());
    expect(findings).toEqual([]);
  });
});
