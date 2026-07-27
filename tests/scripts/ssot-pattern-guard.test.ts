/**
 * SSOT pattern-enforcement ratchet guard (owner directive 2026-07-19; family
 * exemplar: grant-resolver-inventory-guard). Proves, per rule: a planted
 * ad-hoc reimplementation is flagged (red direction), the SSOT primitive
 * module itself and comment mentions are not, allowlisted sites are counted
 * but classified; and for the ratchet: count-above-baseline fails, a
 * count-below-stale-baseline fails demanding a same-commit ratchet-down, the
 * live tree sits exactly at baseline (born green), no allowlist row is stale,
 * and the taxonomy-doc twin matches baseline.json.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PASSTHROUGH_PHRASE_LITERAL,
  SSOT_RULES,
  evaluateRatchet,
  extractStringLiterals,
  readBaselineCount,
  readTaxonomyDocCount,
  runRule,
  scanFileForRule,
  scanRepoForRule,
  stripComments,
  type SsotRuleSpec,
} from '../../scripts/ssot-pattern-guard.ts';
import { PASSTHROUGH_PHRASE } from '../../src/runtimes/agent/command-registry.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function rule(id: string): SsotRuleSpec {
  const found = SSOT_RULES.find((r) => r.id === id);
  if (!found) throw new Error(`rule ${id} not registered`);
  return found;
}

describe('ssot-pattern-guard — arch.ssot-lid-reads', () => {
  const lidRule = rule('arch.ssot-lid-reads');

  it('FLAGS a planted raw lid_mappings read outside lid-resolver', () => {
    const src = "const row = db.raw.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?').get(lid);";
    const findings = scanFileForRule(lidRule, 'src/core/new-module.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.allowlisted).toBe(false);
  });

  it('flags a JOIN as well as a FROM', () => {
    const src = 'const q = `SELECT x FROM chats c LEFT JOIN lid_mappings lm ON c.jid = lm.lid`;';
    expect(scanFileForRule(lidRule, 'src/core/joiner.ts', src)).toHaveLength(1);
  });

  it('does NOT flag the lid-resolver primitive module itself', () => {
    const src = "db.raw.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?');";
    expect(scanFileForRule(lidRule, 'src/core/lid-resolver.ts', src)).toHaveLength(0);
  });

  it('does NOT flag lid_mappings_history (word boundary)', () => {
    const src = "db.raw.prepare('SELECT lid FROM lid_mappings_history WHERE lid = ?');";
    expect(scanFileForRule(lidRule, 'src/core/audit.ts', src)).toHaveLength(0);
  });

  it('does NOT flag a comment that mentions the pattern', () => {
    const src = '// resolved FROM lid_mappings via resolveLid\nconst x = resolveLid(db, lid);';
    expect(scanFileForRule(lidRule, 'src/core/doc-only.ts', src)).toHaveLength(0);
  });

  it('COUNTS an allowlisted site but classifies it allowlisted', () => {
    const src = "db.prepare('SELECT lid, phone_jid FROM lid_mappings').all();";
    const findings = scanFileForRule(lidRule, 'src/core/mentions.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.allowlisted).toBe(true);
  });
});

describe('ssot-pattern-guard — arch.ssot-jid-construction', () => {
  const jidRule = rule('arch.ssot-jid-construction');

  it('FLAGS inline template JID construction', () => {
    const src = 'const key = `${conversationKey}@lid`;';
    const findings = scanFileForRule(jidRule, 'src/core/new-keys.ts', src);
    expect(findings).toHaveLength(1);
  });

  it('FLAGS a literal endsWith-domain predicate', () => {
    const src = "const isGroup = jid.endsWith('@g.us');";
    expect(scanFileForRule(jidRule, 'src/core/pred.ts', src)).toHaveLength(1);
  });

  it('does NOT flag the constants-fed endsWith form (not a drift risk)', () => {
    const src = 'const isLid = jid.endsWith(`@${DOMAIN_LID}`);';
    expect(scanFileForRule(jidRule, 'src/core/lid-resolver.ts', src)).toHaveLength(0);
    expect(scanFileForRule(jidRule, 'src/core/other.ts', src)).toHaveLength(0);
  });

  it('does NOT flag a redaction regex literal containing a quantifier before @lid', () => {
    const src = 'const RE = /\\b[A-Za-z0-9_-]{8,}@lid\\b/i;';
    expect(scanFileForRule(jidRule, 'src/fleet/masker.ts', src)).toHaveLength(0);
  });

  it('does NOT flag the jid-constants primitive module itself', () => {
    const src = 'export function toLidJid(n: string): string { return `${n}@lid`; }';
    expect(scanFileForRule(jidRule, 'src/core/jid-constants.ts', src)).toHaveLength(0);
  });
});

describe('ssot-pattern-guard — arch.ssot-name-ladder', () => {
  const nameRule = rule('arch.ssot-name-ladder');

  it('FLAGS name-column SQL against chats outside chat-display-name', () => {
    const src = "const stmt = db.prepare('SELECT name FROM chats WHERE jid = ?');";
    const findings = scanFileForRule(nameRule, 'src/core/new-render.ts', src);
    expect(findings).toHaveLength(1);
  });

  it('FLAGS a reverse read (WHERE alias = ?) touching a name column', () => {
    const src = "db.prepare('SELECT chat_jid FROM chat_aliases WHERE alias = ?');";
    expect(scanFileForRule(nameRule, 'src/core/reverse.ts', src)).toHaveLength(1);
  });

  it('does NOT flag non-name SQL against the same tables', () => {
    const src = "db.prepare('SELECT unread_count FROM chats WHERE conversation_key = ? LIMIT 1');";
    expect(scanFileForRule(nameRule, 'src/fleet/routes/other.ts', src)).toHaveLength(0);
  });

  it('does NOT flag the chat-display-name primitive module itself', () => {
    const src = "const SQL_CHAT_NAME = 'SELECT name FROM chats WHERE jid = ?';";
    expect(scanFileForRule(nameRule, 'src/core/chat-display-name.ts', src)).toHaveLength(0);
  });

  it('does NOT flag SQL that lives only in a comment', () => {
    const src = "// ladder: 'SELECT name FROM chats WHERE jid = ?'\nconst x = formatChatRefForOwner(db, jid);";
    expect(scanFileForRule(nameRule, 'src/core/doc-only.ts', src)).toHaveLength(0);
  });
});

describe('ssot-pattern-guard — arch.ssot-phone-shape', () => {
  const phoneRule = rule('arch.ssot-phone-shape');

  it('FLAGS a planted anchored phone-shape regex', () => {
    const src = 'const PHONE_RE = /^\\d{7,15}$/;';
    expect(scanFileForRule(phoneRule, 'src/core/new-check.ts', src)).toHaveLength(1);
  });

  it('FLAGS a planted duplicate of the canonical E.164 wire matcher', () => {
    const src = 'export const E164_RE = /^\\+[1-9]\\d{6,14}$/;';
    const findings = scanFileForRule(phoneRule, 'src/transport/new-provider/types.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.allowlisted).toBe(false);
    expect(findings[0]!.detail).toContain('anchored phone-shape regex');
  });

  it('FLAGS plus-formatting over a phone-named interpolation', () => {
    const src = 'const label = `+${digits}`;';
    expect(scanFileForRule(phoneRule, 'src/core/fmt.ts', src)).toHaveLength(1);
  });

  it('does NOT flag a non-phone plus template', () => {
    const src = 'const eta = `+${seconds} seconds`;';
    expect(scanFileForRule(phoneRule, 'src/core/turn-recovery-store.ts', src)).toHaveLength(0);
  });

  it('does NOT flag an IP-address regex (dotted, not a whole-token digit run)', () => {
    const src = 'const IP = /^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/;';
    expect(scanFileForRule(phoneRule, 'src/lib/ssrf-fetch.ts', src)).toHaveLength(0);
  });

  it('does NOT flag the phone primitive module itself', () => {
    const src = 'export function isPhoneLocal(l: string): boolean { return /^\\d{7,15}$/.test(l); }';
    expect(scanFileForRule(phoneRule, 'src/lib/phone.ts', src)).toHaveLength(0);
  });
});

describe('ssot-pattern-guard — arch.ssot-presentation-literals', () => {
  const presRule = rule('arch.ssot-presentation-literals');

  it('FLAGS a re-typed pass-through phrase literal (the pre-extraction fork shape)', () => {
    const src = "return `\\`/${q}\\` is not active here — it is passed through to the agent.`;";
    const findings = scanFileForRule(presRule, 'src/runtimes/agent/new-render.ts', src);
    expect(findings).toHaveLength(1);
  });

  it('does NOT flag the command-registry module that CARRIES the phrase', () => {
    const src = "export const PASSTHROUGH_PHRASE = 'passed through to the agent';";
    expect(scanFileForRule(presRule, 'src/runtimes/agent/command-registry.ts', src)).toHaveLength(0);
  });

  it('does NOT flag a comment mentioning the phrase', () => {
    const src = '// Wording matches the "passed through to the agent" trailer.\nconst x = PASSTHROUGH_PHRASE;';
    expect(scanFileForRule(presRule, 'src/runtimes/agent/doc-only.ts', src)).toHaveLength(0);
  });

  it('guard pattern and the registry constant are the same phrase (no drift)', () => {
    expect(PASSTHROUGH_PHRASE).toBe(PASSTHROUGH_PHRASE_LITERAL);
  });
});

describe('ssot-pattern-guard — ratchet semantics', () => {
  it('count ABOVE baseline fails', () => {
    const verdict = evaluateRatchet('arch.ssot-lid-reads', 7, 6, 'use resolveLid');
    expect(verdict.status).toBe('above-baseline');
    expect(verdict.message).toContain('use resolveLid');
  });

  it('count BELOW a stale baseline fails demanding a same-commit ratchet-down of both twins', () => {
    const verdict = evaluateRatchet('arch.ssot-lid-reads', 5, 6, 'use resolveLid');
    expect(verdict.status).toBe('ratchet-down-required');
    expect(verdict.message).toContain('RATCHET DOWN in this same commit');
    expect(verdict.message).toContain('violationCount=5');
    expect(verdict.message).toContain('.claude/fitness/baseline.json');
    expect(verdict.message).toContain('docs/architecture/fitness-taxonomy.md');
  });

  it('a MISSING baseline entry fails closed', () => {
    const verdict = evaluateRatchet('arch.ssot-never-registered', 0, undefined, 'n/a');
    expect(verdict.status).toBe('missing-baseline');
  });

  it('count AT baseline passes', () => {
    expect(evaluateRatchet('arch.ssot-lid-reads', 6, 6, 'use resolveLid').status).toBe('ok');
    expect(evaluateRatchet('arch.ssot-presentation-literals', 0, 0, 'n/a').status).toBe('ok');
  });
});

describe('ssot-pattern-guard — full-loop fixture (red both directions)', () => {
  function makeFixture(baselineCount: number): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ssot-guard-fixture-'));
    mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
    mkdirSync(path.join(dir, '.claude', 'fitness'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'architecture'), { recursive: true });
    writeFileSync(
      path.join(dir, 'src', 'core', 'planted.ts'),
      "const row = db.raw.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?').get(lid);\n",
      'utf8',
    );
    writeFileSync(
      path.join(dir, '.claude', 'fitness', 'baseline.json'),
      JSON.stringify({ rules: { 'arch.ssot-lid-reads': { violationCount: baselineCount } } }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'docs', 'architecture', 'fitness-taxonomy.md'),
      `| rule | violations (baseline) |\n|------|--|\n| \`arch.ssot-lid-reads\` | ${baselineCount} |\n`,
      'utf8',
    );
    return dir;
  }

  it('a planted violation over a zero baseline FAILS the guard (above-baseline, non-allowlisted named)', () => {
    const dir = makeFixture(0);
    try {
      const result = runRule(dir, rule('arch.ssot-lid-reads'));
      expect(result.ok).toBe(false);
      expect(result.verdict.status).toBe('above-baseline');
      expect(result.nonAllowlisted).toHaveLength(1);
      expect(result.nonAllowlisted[0]!.file).toBe('src/core/planted.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shrink under a STALE baseline FAILS the guard demanding a ratchet-down', () => {
    const dir = makeFixture(2); // actual count in fixture is 1
    try {
      const result = runRule(dir, rule('arch.ssot-lid-reads'));
      expect(result.ok).toBe(false);
      expect(result.verdict.status).toBe('ratchet-down-required');
      expect(result.verdict.message).toContain('violationCount=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a twin-doc mismatch FAILS even when the count sits at baseline', () => {
    const dir = makeFixture(1); // count matches baseline.json…
    try {
      // …but the doc twin disagrees.
      writeFileSync(
        path.join(dir, 'docs', 'architecture', 'fitness-taxonomy.md'),
        '| rule | violations (baseline) |\n|------|--|\n| `arch.ssot-lid-reads` | 3 |\n',
        'utf8',
      );
      const result = runRule(dir, rule('arch.ssot-lid-reads'));
      expect(result.ok).toBe(false);
      expect(result.twinDocMismatch).toContain('twin-doc mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ssot-pattern-guard — live tree (born green, exactly at baseline)', () => {
  it('every rule passes on the live tree with zero non-allowlisted findings', () => {
    for (const spec of SSOT_RULES) {
      const result = runRule(REPO_ROOT, spec);
      expect(result.nonAllowlisted, `${spec.id} non-allowlisted findings`).toEqual([]);
      expect(result.verdict.status, `${spec.id} ${result.verdict.message}`).toBe('ok');
      expect(result.twinDocMismatch, `${spec.id} twin doc`).toBeNull();
      expect(result.ok).toBe(true);
    }
  });

  it('every rule count equals BOTH baseline twins (json + taxonomy doc)', () => {
    for (const spec of SSOT_RULES) {
      const count = scanRepoForRule(REPO_ROOT, spec).length;
      expect(readBaselineCount(REPO_ROOT, spec.id), `${spec.id} baseline.json`).toBe(count);
      expect(readTaxonomyDocCount(REPO_ROOT, spec.id), `${spec.id} taxonomy doc row`).toBe(count);
    }
  });

  it('fails closed when a scanned source file cannot be read', () => {
    const readFailure = (): string => {
      throw new Error('planted source read failure');
    };
    expect(() => scanRepoForRule(REPO_ROOT, rule('arch.ssot-phone-shape'), readFailure))
      .toThrow('planted source read failure');
  });

  it('no allowlist row is stale: each allowlisted file still bears the pattern, with a substantive reason', () => {
    for (const spec of SSOT_RULES) {
      for (const entry of spec.allowlist) {
        const content = readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
        const findings = scanFileForRule(spec, entry.file, content);
        expect(findings.length, `${spec.id} allowlist row ${entry.file} is stale`).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(30);
      }
    }
  });
});

describe('ssot-pattern-guard — lexical helpers', () => {
  it('stripComments blanks block and line comments but preserves offsets/newlines', () => {
    const src = '/* FROM lid_mappings */\nconst a = 1; // FROM lid_mappings\nconst b = 2;';
    const stripped = stripComments(src);
    expect(stripped).not.toContain('lid_mappings');
    expect(stripped.length).toBe(src.length);
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('extractStringLiterals handles quotes, escapes, and template interpolations', () => {
    const src = 'const a = \'x\'; const b = "y\\"z"; const c = `SELECT ${col} FROM chats`;';
    const texts = extractStringLiterals(src).map((l) => l.text);
    expect(texts).toContain('x');
    expect(texts).toContain('y"z');
    expect(texts.some((t) => t.includes('FROM chats'))).toBe(true);
  });
});
