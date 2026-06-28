import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DETECTABILITIES,
  FITNESS_CATEGORIES,
  FITNESS_RINGS,
  FITNESS_SEVERITIES,
  fitnessRules,
  type FitnessRule,
} from '../../scripts/lib/fitness/registry.ts';

interface FitnessBaseline {
  schemaVersion: number;
  generatedAt: string;
  rules: Record<string, {
    measurements: Array<{
      filePath: string;
      lines: number;
    }>;
  }>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readBaseline(): FitnessBaseline {
  return JSON.parse(
    readFileSync(resolve(repoRoot, '.claude/fitness/baseline.json'), 'utf8'),
  ) as FitnessBaseline;
}

describe('fitness rule registry', () => {
  it('has unique, namespaced rule ids with evidence sources', () => {
    const ids = fitnessRules.map((rule) => rule.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(fitnessRules).toHaveLength(28);

    for (const rule of fitnessRules) {
      expect(rule.id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
      expect(FITNESS_CATEGORIES).toContain(rule.category);
      expect(DETECTABILITIES).toContain(rule.detect);
      expect(FITNESS_SEVERITIES).toContain(rule.severity);
      expect(rule.rings.length).toBeGreaterThan(0);
      for (const ring of rule.rings) expect(FITNESS_RINGS).toContain(ring);
      expect(rule.source.length).toBeGreaterThan(0);
      for (const source of rule.source) expect(source.trim()).not.toBe('');
    }
  });

  it('keeps the taxonomy document in sync with registry ids', () => {
    const doc = readFileSync(resolve(repoRoot, 'docs/architecture/fitness-taxonomy.md'), 'utf8');

    for (const rule of fitnessRules) {
      expect(doc).toContain(`\`${rule.id}\``);
    }
  });

  it('has baseline entries for measurement-ratcheted rules', () => {
    const baseline = readBaseline();

    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Rules that use the measurements-based baseline format in baseline.json.
    // arch.import-boundaries uses its own .claude/fitness/boundary-baseline.json instead.
    const measurementRatchetIds = new Set(['arch.file-size']);
    for (const rule of fitnessRules.filter((candidate: FitnessRule) => candidate.ratchet && measurementRatchetIds.has(candidate.id))) {
      const entry = baseline.rules[rule.id];
      expect(entry?.measurements.length).toBeGreaterThan(0);
      for (const measurement of entry.measurements) {
        expect(measurement.filePath).toMatch(/^[^/].+/);
        expect(measurement.lines).toBeGreaterThan(0);
      }
    }
  });

  it('keeps ratcheted rules baseline-able', () => {
    const ratchetedRules = fitnessRules.filter((rule) => rule.ratchet);

    expect(ratchetedRules.map((rule) => rule.id)).toEqual(['arch.file-size', 'arch.import-boundaries']);
    expect(ratchetedRules[0].params).toMatchObject({ maxLines: expect.any(Number) });
    expect(ratchetedRules[1].params).toMatchObject({ layers: expect.any(Object) });
  });
});
