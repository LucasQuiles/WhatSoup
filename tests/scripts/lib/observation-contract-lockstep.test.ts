import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_FILE_NAMES,
  ObservationContractPortError,
  buildObservationContract,
  contractDigest,
  loadObservationContract,
  projectOutcome,
} from '../../../scripts/lib/observation-contract.ts';

/**
 * Cross-language lockstep proof for task-obs-05 (req-obs-02): the Python
 * contract reader (`deploy/scripts/lib/observation_contract.py`) and the TS
 * port (`scripts/lib/observation-contract.ts`) must derive byte-identical
 * contract digests and identical projection output over the SAME document
 * sets — canonical and adversarial. Follows the lockstep pattern established
 * by `tests/scripts/lib/fleet-roster-inventory.test.ts` and
 * `tests/scripts/lib/capture-runtime-receipt-lockstep.test.ts` (shell out to
 * python3, compare byte-for-byte).
 *
 * Both sides read the SAME committed contract set under
 * `deploy/observation-plane/` so there is one source of truth for the
 * documents under test; adversarial cases mutate the parsed docs in memory
 * and pipe them to Python via stdin, never touching the committed files.
 */

// lib/ -> scripts/ -> tests/ -> repo root
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const libDir = path.join(repoRoot, 'deploy/scripts/lib');
const contractDir = path.join(repoRoot, 'deploy/observation-plane');

function loadCommittedDocs(): Record<string, unknown> {
  const docs: Record<string, unknown> = {};
  for (const name of CONTRACT_FILE_NAMES) {
    docs[name] = JSON.parse(readFileSync(path.join(contractDir, name), 'utf8'));
  }
  return docs;
}

// Runs a small Python program with the parsed docs on stdin and returns its
// stdout. `expr` receives `docs` (parsed) and the imported module as `oc`.
function python(expr: string, docs: Record<string, unknown>): string {
  return execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(libDir)})
import observation_contract as oc
docs = json.loads(sys.stdin.read())
${expr}
`], { input: JSON.stringify(docs), encoding: 'utf8' }).trim();
}

describe('observation_contract.py <-> observation-contract.ts (task-obs-05 cross-language lockstep)', () => {
  it('derives the same contract digest as Python for the committed contract set', () => {
    const docs = loadCommittedDocs();
    const tsDigest = contractDigest(docs);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', docs);

    expect(tsDigest).toBe(pyDigest);
    expect(tsDigest).toMatch(/^[0-9a-f]{64}$/);
    // The file loaders bind to the same bytes.
    expect(loadObservationContract(contractDir).digest).toBe(tsDigest);
  });

  it('projects every declared legacy value identically to Python', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    const tsMatrix: Record<string, Record<string, { canonical: string; lossy: boolean }>> = {};
    for (const [surfaceName, surface] of Object.entries(contract.surfaces)) {
      tsMatrix[surfaceName] = {};
      for (const member of surface.domain) {
        const row = projectOutcome(contract, surfaceName, member);
        tsMatrix[surfaceName][member] = { canonical: row.canonical, lossy: row.lossy };
      }
    }
    const pyMatrix = python(
      `
contract = oc.build_contract(docs)
matrix = {}
for surface_name, surface in contract["surfaces"].items():
    matrix[surface_name] = {}
    for member in surface["domain"]:
        row = oc.project_outcome(contract, surface_name, member)
        matrix[surface_name][member] = {"canonical": row["canonical"], "lossy": row["lossy"]}
sys.stdout.write(json.dumps(matrix, sort_keys=True, separators=(",", ":")))
`,
      docs,
    );

    // Structure-equal across languages, over at least the 8 closed surfaces.
    expect(JSON.parse(pyMatrix)).toEqual(tsMatrix);
    expect(Object.keys(tsMatrix).length).toBeGreaterThanOrEqual(8);
  });

  it('stays in lockstep on content mutation (digest moves identically on both sides)', () => {
    const docs = loadCommittedDocs();
    const baselineTs = contractDigest(docs);
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const projections = mutated['outcome-projections.json'] as {
      surfaces: Record<string, { rows: Array<Record<string, unknown>> }>;
    };
    const firstSurface = Object.values(projections.surfaces)[0]!;
    firstSurface.rows[0]!['lossy'] = !firstSurface.rows[0]!['lossy'];

    const tsDigest = contractDigest(mutated);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', mutated);

    expect(tsDigest).toBe(pyDigest);
    expect(tsDigest).not.toBe(baselineTs);
  });

  it('stays in lockstep on non-ASCII content (python ensure_ascii escaping)', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['description'] =
      'unicode lockstep: état sévère — 健康 \u{1f9ea}';

    const tsDigest = contractDigest(mutated);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', mutated);

    expect(tsDigest).toBe(pyDigest);
  });

  it('fails closed identically on an out-of-domain legacy value', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    expect(() => projectOutcome(contract, 'probe_report_verdict', 'outside-the-domain')).toThrow(
      ObservationContractPortError,
    );
    const pyResult = python(
      `
contract = oc.build_contract(docs)
try:
    oc.project_outcome(contract, "probe_report_verdict", "outside-the-domain")
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      docs,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects a non-total projection table identically at build time', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const projections = mutated['outcome-projections.json'] as {
      surfaces: Record<string, { rows: Array<Record<string, unknown>> }>;
    };
    projections.surfaces['probe_report_verdict']!.rows.shift();

    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });
});
