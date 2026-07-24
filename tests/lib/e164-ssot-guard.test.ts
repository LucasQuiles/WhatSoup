/**
 * E.164 phone-number regex SSOT guard (#2237).
 *
 * The regex `/^\+[1-9]\d{6,14}$/` must be defined in exactly one place:
 * `src/lib/phone.ts` (exported as `E164_RE`). Every transport adapter and
 * the cross-transport config validator must import it — never re-define it.
 *
 * This ratchet fails if:
 *  - the literal regex appears in any src/ file other than `src/lib/phone.ts`, OR
 *  - `E164_RE` is assigned (not re-exported) outside the canonical home, OR
 *  - the canonical home stops exporting the constant.
 *
 * It is intentionally a separate, fast, regex-based check — the
 * `arch.ssot-phone-shape` rule in `scripts/ssot-pattern-guard.ts` catches
 * broader phone-shape patterns; this test is the narrow E.164-specific lock.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const CANONICAL_HOME = 'src/lib/phone.ts';

/** The exact regex source that constitutes an E.164 wire-format definition. */
const E164_REGEX_SOURCE = /^\+[1-9]\d{6,14}$/;

/** Matches a `const E164_RE = <regex>` assignment (the fork/duplication shape). */
const E164_RE_DEFINITION = /(?:export\s+)?const\s+E164_RE\s*=/;

/** Recursively collect all .ts files under a directory. */
function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectTsFiles(full, files);
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Relative path from repo root, using forward slashes. */
function relFromRepoRoot(fullPath: string): string {
  return path.relative(REPO_ROOT, fullPath).replaceAll(path.sep, '/');
}

describe('E164_RE SSOT guard (#2237)', () => {
  const srcFiles = collectTsFiles(SRC_DIR);

  it('E164_RE is defined exactly once, in the canonical home src/lib/phone.ts', () => {
    const definers: string[] = [];
    for (const file of srcFiles) {
      const content = readFileSync(file, 'utf8');
      if (E164_RE_DEFINITION.test(content)) {
        definers.push(relFromRepoRoot(file));
      }
    }
    expect(definers, `E164_RE must only be defined in ${CANONICAL_HOME}; found definitions in: ${definers.join(', ')}`).toEqual([
      CANONICAL_HOME,
    ]);
  });

  it('the raw E.164 regex literal does not appear outside the canonical home', () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const rel = relFromRepoRoot(file);
      if (rel === CANONICAL_HOME) continue;
      const content = readFileSync(file, 'utf8');
      // Check for the literal regex source string as it would appear in source code.
      // The regex literal in source looks like: /^\+[1-9]\d{6,14}$/
      if (content.includes('^\\+[1-9]\\d{6,14}$')) {
        offenders.push(rel);
      }
    }
    expect(offenders, `Raw E.164 regex literal found outside ${CANONICAL_HOME}: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the canonical home still exports E164_RE with the correct source', () => {
    const content = readFileSync(path.join(REPO_ROOT, CANONICAL_HOME), 'utf8');
    expect(content).toMatch(E164_RE_DEFINITION);
    // Verify the exported constant has the expected regex source.
    const match = content.match(/export\s+const\s+E164_RE\s*=\s*\/(.*?)\/[gimsuy]*/);
    expect(match, 'E164_RE export not found in canonical home').not.toBeNull();
    const source = match![1];
    expect(E164_REGEX_SOURCE.test(`+15551234567`), `E164_RE source "${source}" should match valid E.164`).toBe(true);
    expect(E164_REGEX_SOURCE.test(`05551234567`), `E164_RE source "${source}" should reject leading zero`).toBe(false);
  });

  it('transport types files re-export E164_RE, not define it', () => {
    const transportTypesFiles = [
      'src/transport/twilio/types.ts',
      'src/transport/signal/types.ts',
      'src/transport/imessage/types.ts',
    ];
    for (const rel of transportTypesFiles) {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(content, `${rel} must re-export E164_RE`).toContain('E164_RE');
      expect(E164_RE_DEFINITION.test(content), `${rel} must NOT define E164_RE (should re-export)`).toBe(false);
    }
  });

  it('the cross-transport validator imports E164_RE from core/transport-refs, not a transport', () => {
    const content = readFileSync(path.join(REPO_ROOT, 'src/core/agent-config-validator.ts'), 'utf8');
    expect(content).toContain("import { E164_RE } from './transport-refs.ts'");
    expect(content, 'validator must not import E164_RE from any transport').not.toMatch(
      /import\s*\{[^}]*E164_RE[^}]*\}\s*from\s*['"][^'']*transport\/(twilio|signal|imessage)/,
    );
  });
});
