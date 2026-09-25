/**
 * The recovery_debt contract is re-implemented by four parties: the producer
 * (src/core/recovery-debt.ts) and three consumers that validate the /health
 * body independently (the fleet health poller, deploy classify_health.py and
 * the rendered watchdog). The shared fixture exercises the consumers' logic but
 * not their vocabulary, so a reason added to the producer alone would make every
 * consumer reject valid bodies. This test reads each consumer's literal lists
 * straight from source and pins them to the producer's exported order and
 * blocking set. The release validator imports both lists from the producer
 * instead of re-encoding them (see
 * tests/scripts/startup-notification-release-validator-vocabulary.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RECOVERY_BLOCKING_REASONS, RECOVERY_REASON_ORDER } from '../../src/core/recovery-debt.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** Quoted string literals between `startMarker` and the first `endMarker` after it. */
function literalsIn(source: string, startMarker: string, endMarker: string): string[] {
  const start = source.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + startMarker.length;
  const end = source.indexOf(endMarker, bodyStart);
  expect(end, `end marker not found after: ${startMarker}`).toBeGreaterThan(bodyStart);
  return [...source.slice(bodyStart, end).matchAll(/["']([a-z_]+)["']/g)].map((match) => match[1]!);
}

const consumers = {
  'src/fleet/health-poller.ts': {
    order: ['const RECOVERY_DEBT_REASON_ORDER = [', ']'],
    blocking: ['const RECOVERY_DEBT_BLOCKING_REASONS = new Set([', ']'],
  },
  'deploy/scripts/lib/classify_health.py': {
    order: ['RECOVERY_DEBT_REASON_ORDER = (', ')'],
    blocking: ['RECOVERY_DEBT_BLOCKING_REASONS = {', '}'],
  },
  'deploy/templates/watchdog-script.sh': {
    order: ['recovery_reason_order = (', ')'],
    blocking: ['recovery_blocking_reasons = {', '}'],
  },
} as const;

describe('recovery_debt reason vocabulary parity', () => {
  it('the producer order is a non-empty list of distinct reasons', () => {
    expect(RECOVERY_REASON_ORDER.length).toBe(16);
    expect(new Set(RECOVERY_REASON_ORDER).size).toBe(RECOVERY_REASON_ORDER.length);
  });

  for (const [file, markers] of Object.entries(consumers)) {
    it(`${file} re-encodes the producer reason order exactly`, () => {
      const order = literalsIn(read(file), markers.order[0], markers.order[1]);
      expect(order).toEqual([...RECOVERY_REASON_ORDER]);
    });
  }

  it('the three consumers agree on the blocking subset, drawn from the producer order', () => {
    const subsets = Object.entries(consumers).map(([file, markers]) => (
      literalsIn(read(file), markers.blocking[0], markers.blocking[1]).sort()
    ));
    expect(subsets[0]!.length).toBe(8);
    expect(subsets[0]).toEqual([...RECOVERY_BLOCKING_REASONS].sort());
    expect(subsets[1]).toEqual(subsets[0]);
    expect(subsets[2]).toEqual(subsets[0]);
    for (const reason of subsets[0]!) {
      expect(RECOVERY_REASON_ORDER as readonly string[]).toContain(reason);
    }
  });
});
