// Smoke coverage for the two P3.6 evidence-only probe scripts.
//
// These scripts (scripts/p36-h3-ollama-probe.ts, scripts/p36-h4-local-pipeline-proof.ts)
// are documented in their headers as DO NOT COMMIT ephemeral evidence tooling
// that runs top-level on import (no main()-gating, real network calls). A
// behavioral smoke test would require either live Ollama or a refactor that's
// out of scope for #267.
//
// What this file *does* enforce:
//   - The scripts exist on disk and have non-empty content.
//   - The scripts carry their evidence-only header so they are not silently
//     promoted to production tooling without an audit.
//
// `it.todo` placeholders are recorded for a real CLI smoke test
// (e.g. `--help` or fast-exit path) once the probes are productionized
// or removed. Tracks the coverage gap surfaced by issue #267.

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PROBES = [
  'scripts/p36-h3-ollama-probe.ts',
  'scripts/p36-h4-local-pipeline-proof.ts',
] as const;

describe('p36 probe scripts smoke (#267)', () => {
  for (const rel of PROBES) {
    describe(rel, () => {
      const abs = resolve(REPO_ROOT, rel);

      it('exists and is non-empty', () => {
        const st = statSync(abs);
        expect(st.isFile()).toBe(true);
        expect(st.size).toBeGreaterThan(0);
      });

      it('carries the DO NOT COMMIT evidence-only header', () => {
        const head = readFileSync(abs, 'utf8').slice(0, 800);
        expect(head).toMatch(/^\/\/.*DO NOT COMMIT/m);
      });

      it.todo(
        'exits cleanly with --help (requires probe to be productionized; see #267)',
      );
    });
  }
});
