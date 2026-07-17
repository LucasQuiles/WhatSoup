import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { receiptCapabilityDigest } from '../../../scripts/lib/fleet-receipt-digest.ts';

/**
 * Cross-language lockstep proof for #1867 criterion 1: the Python
 * capture-producer's digest (`deploy/scripts/receipts/capture_runtime_receipt.py`,
 * `capability_digest`) must equal the guard's own
 * `receiptCapabilityDigest` (`scripts/lib/fleet-receipt-digest.ts`) for the
 * SAME receipt bundle. Follows the same lockstep pattern already established
 * by `tests/scripts/lib/fleet-roster-inventory.test.ts` (shell out to
 * python3, compare byte-for-byte) and mirrors the inline python computation
 * already exercised in `tests/scripts/lib/fleet-receipt-digest.test.ts`
 * ("matches a Python sha256(json.dumps(...)) computation") -- this file is
 * the real producer replacing that inline stand-in.
 *
 * Both sides read the SAME fixture file
 * (`deploy/scripts/receipts/tests/fixtures/lockstep-receipt.json`) so there
 * is one source of truth for the bundle under test, not two hand-copied
 * literals that could silently drift apart.
 */

// lib/ -> scripts/ -> tests/ -> repo root
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const receiptsDir = path.join(repoRoot, 'deploy/scripts/receipts');
const fixturePath = path.join(receiptsDir, 'tests/fixtures/lockstep-receipt.json');

function pythonCapabilityDigest(bundle: unknown): string {
  return execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(receiptsDir)})
from capture_runtime_receipt import capability_digest
data = json.loads(sys.stdin.read())
sys.stdout.write(capability_digest(data))
`], { input: JSON.stringify(bundle), encoding: 'utf8' }).trim();
}

describe('capture_runtime_receipt.py <-> fleet-receipt-digest.ts (#1867 criterion 1, cross-language lockstep)', () => {
  it('produces the same digest as the TS guard for the shared committed fixture bundle', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

    const pythonDigest = pythonCapabilityDigest(fixture);
    const tsDigest = receiptCapabilityDigest(fixture);

    expect(pythonDigest).toBe(tsDigest);
    expect(pythonDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stays in lockstep when the fallback chain order is preserved (order-sensitive, not sorted)', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const reordered = {
      ...fixture,
      fallbackChain: [...fixture.fallbackChain].reverse(),
    };

    const pythonDigest = pythonCapabilityDigest(reordered);
    const tsDigest = receiptCapabilityDigest(reordered);

    expect(pythonDigest).toBe(tsDigest);
    // Reordering a multi-entry fallbackChain is a real content change (order
    // is semantic priority, per design), so it must differ from the original.
    expect(pythonDigest).not.toBe(receiptCapabilityDigest(fixture));
  });

  it('stays in lockstep across identity-field edits (commit, schemaMigration, provider, driftCheck.ok)', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const edited = {
      ...fixture,
      commit: 'b'.repeat(40),
      schemaMigration: 45,
      provider: 'openai-cli',
      driftCheck: { ok: false },
    };

    const pythonDigest = pythonCapabilityDigest(edited);
    const tsDigest = receiptCapabilityDigest(edited);

    expect(pythonDigest).toBe(tsDigest);
    expect(pythonDigest).not.toBe(receiptCapabilityDigest(fixture));
  });
});
