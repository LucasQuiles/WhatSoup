import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRepo, scanRepoDetailed, scanScript } from '../../scripts/shell-node-integer-capture-guard.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

describe('shell-node-integer-capture-guard — scanScript (unit, inline fixtures)', () => {
  it('flags a node -e capture reaching -eq with no validation (the literal #2449 shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "COUNT=$(printf %s \"$X\" | node -e 'console.log(1)')",
      'if [ "$COUNT" -eq 0 ]; then',
      '  echo clean',
      'fi',
    ].join('\n');
    const findings = scanScript('scripts/example.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.variable).toBe('COUNT');
    expect(findings[0]!.line).toBe(3);
  });

  it('does NOT flag when the node -e script emits via process.stdout.write (arm A: safe emission)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "COUNT=$(printf %s \"$X\" | node -e 'process.stdout.write(String(1))')",
      'if [ "$COUNT" -eq 0 ]; then',
      '  echo clean',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toEqual([]);
  });

  it('does NOT flag when a grep -qE numeric validation intervenes before the compare (arm B)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "COUNT=$(printf %s \"$X\" | node -e 'console.log(1)')",
      'if ! printf %s "$COUNT" | grep -qE \'^[0-9]+$\'; then',
      '  echo "parse error"; exit 1',
      'fi',
      'if [ "$COUNT" -eq 0 ]; then',
      '  echo clean',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toEqual([]);
  });

  it('DOES still flag when the grep -qE validation appears AFTER the compare, not before (order matters)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "COUNT=$(printf %s \"$X\" | node -e 'console.log(1)')",
      'if [ "$COUNT" -eq 0 ]; then',
      '  echo clean',
      'fi',
      'printf %s "$COUNT" | grep -qE \'^[0-9]+$\' || exit 1',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toHaveLength(1);
  });

  it('does NOT flag a node -e capture that is only ever printed as a display string (WAIVER_SYNC_SUMMARY shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "SUMMARY=$(printf %s \"$X\" | node -e 'console.log(\"hi\")')",
      'if [ -n "$SUMMARY" ]; then',
      '  echo "$SUMMARY"',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toEqual([]);
  });

  it('flags an unvalidated RIGHT-operand comparison (`-lt "$VAR"` shape, as in deploy/setup.sh:152)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "BOUND=$(node -e 'console.log(5)')",
      'if [ "$node_major" -lt "$BOUND" ]; then',
      '  echo ok',
      'fi',
    ].join('\n');
    const findings = scanScript('deploy/example.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.variable).toBe('BOUND');
  });

  it('flags an arithmetic (( )) comparison', () => {
    const script = [
      '#!/usr/bin/env bash',
      "N=$(node -e 'console.log(3)')",
      'if (( N > 0 )); then',
      '  echo ok',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toHaveLength(1);
  });

  it('flags node -p captures even with no console.log in scope (auto-print is always unsafe emission)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "N=$(node -p '1+1')",
      'if [ "$N" -eq 2 ]; then',
      '  echo ok',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toHaveLength(1);
  });

  it('does NOT flag node -p when grep -qE numeric validation intervenes (only arm B can clear -p)', () => {
    const script = [
      '#!/usr/bin/env bash',
      "N=$(node -p '1+1')",
      'if ! printf %s "$N" | grep -qE \'^[0-9]+$\'; then exit 1; fi',
      'if [ "$N" -eq 2 ]; then',
      '  echo ok',
      'fi',
    ].join('\n');
    expect(scanScript('scripts/example.sh', script)).toEqual([]);
  });

  it('handles a multi-line node -e script body that emits safely (matches deploy/setup.sh:135-143 shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'BOUND="$(node -e \'',
      'const fs = require("fs");',
      'process.stdout.write("5");',
      '\' 2>/dev/null || true)"',
      'if [ "$node_major" -lt "$BOUND" ]; then',
      '  echo ok',
      'fi',
    ].join('\n');
    expect(scanScript('deploy/example.sh', script)).toEqual([]);
  });

  it('flags a multi-line node -e script body that console.logs the value (regression shape)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'BOUND="$(node -e \'',
      'const fs = require("fs");',
      'console.log(5);',
      '\' 2>/dev/null || true)"',
      'if [ "$node_major" -lt "$BOUND" ]; then',
      '  echo ok',
      'fi',
    ].join('\n');
    expect(scanScript('deploy/example.sh', script)).toHaveLength(1);
  });

  it('does NOT flag an unrelated variable in an integer comparison that never came from node -e/-p', () => {
    const script = ['#!/usr/bin/env bash', 'read -r N', 'if [ "$N" -eq 0 ]; then echo ok; fi'].join('\n');
    expect(scanScript('scripts/example.sh', script)).toEqual([]);
  });

  it('an earlier unrelated single-quoted argument on the capture line does not confuse the script-quote anchor', () => {
    // `printf '%s'` opens/closes its OWN single quote before `node -e '` ever appears;
    // the NODE_FLAG_RE anchor must skip past it rather than pairing with the wrong quote.
    const script = [
      '#!/usr/bin/env bash',
      "COUNT=$(printf '%s' \"$X\" | node -e 'console.log(1)')",
      'if [ "$COUNT" -eq 0 ]; then echo clean; fi',
    ].join('\n');
    const findings = scanScript('scripts/example.sh', script);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.variable).toBe('COUNT');
  });
});

describe('shell-node-integer-capture-guard — real-repo positive control', () => {
  it('classifies all 3 known node -e captures on current main as clean: 2 safe (deploy/setup.sh), 1 display-only (design-regression.sh), 0 flagged', () => {
    const setupContent = readFileSync(path.join(repoRoot, 'deploy/setup.sh'), 'utf8');
    const designContent = readFileSync(path.join(repoRoot, 'console/scripts/design-regression.sh'), 'utf8');

    expect(scanScript('deploy/setup.sh', setupContent)).toEqual([]);
    expect(scanScript('console/scripts/design-regression.sh', designContent)).toEqual([]);

    // Non-vacuity: prove the scan actually SAW node -e captures rather than silently
    // examining files that happen to contain none — a scanner that sees zero captures
    // would trivially "pass" without ever exercising the detection logic at all.
    expect(setupContent.match(/\bnode\s+-e\s+'/g)?.length).toBeGreaterThanOrEqual(1);
    expect(designContent.match(/\bnode\s+-e\s+'/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('repo-wide scanRepoDetailed finds zero findings on current main over a non-vacuous population', () => {
    const result = scanRepoDetailed(repoRoot);
    expect(result.findings).toEqual([]);
    expect(result.totalCaptures).toBeGreaterThanOrEqual(3);
    expect(result.scannedFiles).toBeGreaterThanOrEqual(2);
  });

  it('scanRepo (findings-only view) agrees with scanRepoDetailed on current main', () => {
    expect(scanRepo(repoRoot)).toEqual([]);
  });

  it('FAIL-CLOSED: throws rather than reporting clean when 0 shell files are read', () => {
    expect(() => scanRepoDetailed(path.join(repoRoot, 'node_modules', '.bin'))).toThrow();
  });
});
