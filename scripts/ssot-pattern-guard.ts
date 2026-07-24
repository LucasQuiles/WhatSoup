#!/usr/bin/env node
// scripts/ssot-pattern-guard.ts
//
// SSOT pattern-enforcement RATCHET guard (owner directive 2026-07-19; B25 SSOT
// wave). Family exemplar: scripts/grant-resolver-inventory-guard.ts (b24, G-E).
//
// Each rule bans an ad-hoc reimplementation of a canonical shared module
// ("SSOT primitive") and ratchets the count of surviving sites toward zero:
//
//   arch.ssot-lid-reads            raw lid_mappings SQL reads outside
//                                  src/core/lid-resolver.ts (resolveLid).
//   arch.ssot-jid-construction     inline `${x}@s.whatsapp.net`-class template
//                                  construction and literal `.endsWith('@lid')`-class
//                                  predicates outside src/core/jid-constants.ts.
//   arch.ssot-name-ladder          SQL touching the NAME columns of
//                                  contacts/chats/groups/chat_aliases outside
//                                  src/core/chat-display-name.ts (formatChatRefForOwner).
//   arch.ssot-phone-shape          anchored phone-shape regex literals and
//                                  `+${…phone…}` plus-formatting outside src/lib/phone.ts.
//   arch.ssot-presentation-literals  the user-facing pass-through phrase forked
//                                  outside src/runtimes/agent/command-registry.ts
//                                  (GATE_PRESENTATION class; see PASSTHROUGH_PHRASE).
//
// RATCHET SEMANTICS (.claude/fitness/baseline.json `rules.<id>.violationCount`,
// twin row in docs/architecture/fitness-taxonomy.md — the two must match):
//   - Any finding in a file NOT on the rule's allowlist fails the build,
//     naming the primitive to rewire to.
//   - total count > baseline  → FAIL (new debt, even inside allowlisted files).
//   - total count < baseline  → FAIL demanding the baseline (both twins) be
//     LOWERED in the same commit — ratchet-down enforcement. Migrations shrink
//     the baseline toward zero; a zero-baseline rule is a pure block.
//   - Allowlist rows are DEBT MARKERS, not permanent exemptions: every row
//     carries a reason naming why the primitive cannot serve that site today,
//     and the companion test fails when a row goes stale (file no longer
//     contains the pattern).
//
// SCOPE / LIMITS (stated honestly, not overclaimed):
//   - Scanning is lexical over comment-stripped source (prose that MENTIONS a
//     banned form is never flagged; only code is). It does not typecheck or
//     resolve imports.
//   - ssot-lid-reads matches `FROM|JOIN lid_mappings` reads only. Writes
//     (INSERT/UPDATE) already live solely in lid-resolver.ts and are covered by
//     the lid-resolver write-seam tests, not this rule (`DELETE FROM` would
//     still match the read pattern and be flagged).
//   - ssot-jid-construction catches template construction ending in a literal
//     domain (`${x}@lid`) and endsWith with a LITERAL domain string. It does
//     not catch string concatenation (`x + '@lid'` — zero sites today), nor
//     endsWith over the jid-constants-derived `` `@${DOMAIN_LID}` `` form
//     (which is constants-fed and not a drift risk).
//   - ssot-name-ladder inspects extracted string literals for a
//     contacts/chats/groups/chat_aliases table reference PLUS a name-column
//     token in the same literal. messages.sender_name reads are out of scope
//     (the messages table serves many non-name purposes). The string extractor
//     treats `${…}` interpolations as opaque text; a nested backtick inside an
//     interpolation would end the literal early (no such site today).
//   - ssot-phone-shape catches whole-token anchored shapes (`/^\+?\d{m,n}$/`
//     class) and `+${…}` templates whose interpolation NAMES a phone-ish
//     identifier (phone/digits/e164/msisdn). A plus-format over an opaque
//     variable name escapes; so does digit-run redaction/matching that is not
//     anchored as a whole token (deliberate — those are masking patterns, a
//     different concern than phone identity).
//   - ssot-presentation-literals starts NARROW (the pass-through phrase only) —
//     it guards the constant extracted in command-registry.ts against
//     re-forking; it is not a general prose-duplication detector.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SsotFinding {
  rule: string;
  file: string;
  line: number;
  allowlisted: boolean;
  detail: string;
}

export interface SsotAllowlistEntry {
  file: string;
  reason: string;
}

export interface SsotRuleSpec {
  id: string;
  /** Canonical module(s) — the primitive itself is never scanned. */
  ssotModules: readonly string[];
  /** Scan roots relative to the repo root. */
  roots: readonly string[];
  /** File extensions scanned under the roots (tests are always excluded). */
  extensions: readonly string[];
  /** Known surviving sites, each justified. Debt markers (W1.5 shrinks them). */
  allowlist: readonly SsotAllowlistEntry[];
  /** Names the primitive in every failure message. */
  remediation: string;
  /** Return match offsets (into the comment-stripped content). */
  findMatches(stripped: string): Array<{ index: number; detail: string }>;
}

// ---------------------------------------------------------------------------
// Shared lexical helpers
// ---------------------------------------------------------------------------

/**
 * Blank out `//` line comments and block comments so prose that MENTIONS a
 * banned pattern is not flagged — only real code is. Newlines are preserved so
 * match offsets/line numbers stay accurate (b24 exemplar convention). Not
 * string-literal-aware, which is acceptable for these rules: a URL containing
 * `//` inside a string would only ever HIDE a later same-line match, and no
 * scanned pattern co-occurs with URLs today.
 */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * Extract string literals ('…', "…", `…`) with their start offsets from
 * comment-stripped source. Template `${…}` interpolations are kept as opaque
 * text inside the literal (brace-depth tracked). Regex literals are not
 * modelled; no scanned file mixes quote-bearing regexes with SQL today (the
 * companion test pins the live-tree finding set, so a tokenizer misfire is a
 * visible diff, not a silent miss).
 */
export function extractStringLiterals(stripped: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const ch = stripped[i]!;
    if (ch === "'" || ch === '"') {
      const start = i;
      i += 1;
      let text = '';
      while (i < n && stripped[i] !== ch && stripped[i] !== '\n') {
        if (stripped[i] === '\\') {
          text += stripped[i + 1] ?? '';
          i += 2;
        } else {
          text += stripped[i];
          i += 1;
        }
      }
      i += 1; // closing quote (or newline bail on unterminated)
      out.push({ start, text });
    } else if (ch === '`') {
      const start = i;
      i += 1;
      let text = '';
      let braceDepth = 0;
      while (i < n) {
        const c = stripped[i]!;
        if (c === '\\') {
          text += stripped[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (braceDepth === 0 && c === '`') break;
        if (c === '$' && stripped[i + 1] === '{') {
          braceDepth += 1;
          text += '${';
          i += 2;
          continue;
        }
        if (braceDepth > 0 && c === '{') braceDepth += 1;
        if (braceDepth > 0 && c === '}') braceDepth -= 1;
        text += c;
        i += 1;
      }
      i += 1; // closing backtick
      out.push({ start, text });
    } else {
      i += 1;
    }
  }
  return out;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function regexMatches(
  stripped: string,
  re: RegExp,
  detail: string,
): Array<{ index: number; detail: string }> {
  const matches: Array<{ index: number; detail: string }> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    matches.push({ index: m.index, detail });
    if (m.index === re.lastIndex) re.lastIndex += 1; // safety on zero-width
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

const LID_READ_RE = /\b(?:FROM|JOIN)\s+lid_mappings\b/gi;

const JID_TEMPLATE_RE = /\$\{[^}\n]*\}@(?:s\.whatsapp\.net|lid|g\.us|sms)/g;
const JID_ENDSWITH_RE =
  /\.endsWith\(\s*(?:'@(?:s\.whatsapp\.net|lid|g\.us|sms)'|"@(?:s\.whatsapp\.net|lid|g\.us|sms)"|`@(?:s\.whatsapp\.net|lid|g\.us|sms)`)\s*\)/g;

const NAME_LADDER_TABLE_RE = /\b(?:FROM|JOIN)\s+(?:contacts|chats|groups|chat_aliases)\b/i;
const NAME_LADDER_COLUMN_RE = /\b(?:name|alias|subject|display_name|notify_name)\b/i;

const PHONE_ANCHORED_SHAPE_RE = /\^(?:\\\+\??)?(?:\[[^\]\n]{1,10}\])?\\d\{\d{1,2},\d{1,2}\}\$/g;
const PHONE_PLUS_TEMPLATE_RE = /`\+\$\{[^}\n]*(?:phone|digits|e164|msisdn)[^}\n]*\}/gi;

export const PASSTHROUGH_PHRASE_LITERAL = 'passed through to the agent';
const PASSTHROUGH_RE = /passed through to the agent/g;

export const SSOT_RULES: readonly SsotRuleSpec[] = [
  {
    id: 'arch.ssot-lid-reads',
    ssotModules: ['src/core/lid-resolver.ts'],
    roots: ['src'],
    extensions: ['.ts'],
    remediation:
      'route LID→phone resolution through src/core/lid-resolver.ts resolveLid()',
    allowlist: [
      {
        file: 'src/core/mentions.ts',
        reason:
          'getAllLidMappings builds the BIDIRECTIONAL lid↔phone mention map in one bulk read (the reverse phone→lid direction included); resolveLid is forward-only and single-key. W1.5 debt: move the bulk getter into lid-resolver.',
      },
      {
        file: 'src/core/outbound-identity/store.ts',
        reason:
          'SqliteIdentityStore.resolveLid implements the outbound-identity IdentityStore port over a bare node:sqlite handle — that seam has no app Database wrapper, which lid-resolver.resolveLid requires. Debt: thread the wrapper (or extract a raw-handle core) and delete this copy.',
      },
      {
        file: 'src/mcp/tools/chat-management.ts',
        reason:
          'list_chats conversation-list CTE joins lid_mappings SET-WISE across every row in one SQL pass; the imperative per-key resolveLid cannot express a JOIN. Debt: a lid-resolver-owned SQL view/fragment would re-centralize it.',
      },
      {
        file: 'src/fleet/index.ts',
        reason:
          'fleet inventory endpoints export the raw mapping table INCLUDING updated_at for cross-instance reconciliation; resolveLid exposes neither bulk iteration nor timestamps.',
      },
      {
        file: 'src/fleet/routes/lines.ts',
        reason:
          'admin display route bulk-loads the lid→phone map for phone rendering — bulk read, same class as fleet/index.ts.',
      },
    ],
    findMatches: (stripped) =>
      regexMatches(
        stripped,
        LID_READ_RE,
        'raw lid_mappings SQL read outside lid-resolver.ts',
      ),
  },
  {
    id: 'arch.ssot-jid-construction',
    ssotModules: ['src/core/jid-constants.ts'],
    roots: ['src'],
    extensions: ['.ts'],
    remediation:
      'use src/core/jid-constants.ts builders/predicates (toPersonalJid/toLidJid/toSmsJid, isPnJid/isLidJid/isGroupJid/isSmsJid)',
    allowlist: [
      {
        file: 'src/core/admin.ts',
        reason:
          '`+${normalizePhoneE164(phone)}@sms` composes an SMS JID inline; toSmsJid exists but the site also plus-formats the phone (see arch.ssot-phone-shape) — migrate both together (W1.5 debt).',
      },
      {
        file: 'src/runtimes/agent/runtime.ts',
        reason:
          'two `${conversationKey}@lid` probe keys and one endsWith(\'@g.us\') group predicate predate jid-constants; behaviour-identical migration to toLidJid/isGroupJid pending (runtime.ts edits batched separately to keep the guard wave src-minimal).',
      },
      {
        file: 'src/mcp/tools/advanced.ts',
        reason:
          'raw-JID validation gate spells the three delivery domains as endsWith literals; migrate to the jid-constants delivery-namespace predicates (W1.5 debt).',
      },
    ],
    findMatches: (stripped) => [
      ...regexMatches(
        stripped,
        JID_TEMPLATE_RE,
        'inline template JID construction — use toPersonalJid/toLidJid/toSmsJid',
      ),
      ...regexMatches(
        stripped,
        JID_ENDSWITH_RE,
        "literal endsWith('@…') JID-domain predicate — use isPnJid/isLidJid/isGroupJid/isSmsJid",
      ),
    ],
  },
  {
    id: 'arch.ssot-name-ladder',
    ssotModules: ['src/core/chat-display-name.ts'],
    roots: ['src'],
    extensions: ['.ts'],
    remediation:
      'resolve owner-facing chat/contact names through src/core/chat-display-name.ts formatChatRefForOwner()',
    allowlist: [
      {
        file: 'src/fleet/routes/data.ts',
        reason:
          'console chat-list enrichment reads groups.subject and chats.name set-wise per instance; W1.5 migration to the shared ladder pending.',
      },
      {
        file: 'src/mcp/tools/search.ts',
        reason:
          'search_contacts LIKE-matches display_name/notify_name set-wise across the contacts table; W1.5 migration pending.',
      },
      {
        file: 'src/mcp/tools/chat-management.ts',
        reason:
          'list_chats CTE selects chats.name set-wise across the conversation list in one SQL pass — same W1.5 class as fleet data.ts / mcp search.ts.',
      },
      {
        file: 'src/core/chats-resolver.ts',
        reason:
          'send-direction alias resolution (alias → chat_jid) — the REVERSE lookup of the display ladder; formatChatRefForOwner renders jid → name and cannot serve it (different concern, stays).',
      },
    ],
    findMatches: (stripped) => {
      const matches: Array<{ index: number; detail: string }> = [];
      for (const literal of extractStringLiterals(stripped)) {
        if (NAME_LADDER_TABLE_RE.test(literal.text) && NAME_LADDER_COLUMN_RE.test(literal.text)) {
          matches.push({
            index: literal.start,
            detail:
              'SQL touching a name column of contacts/chats/groups/chat_aliases outside chat-display-name.ts',
          });
        }
      }
      return matches;
    },
  },
  {
    id: 'arch.ssot-phone-shape',
    ssotModules: ['src/lib/phone.ts'],
    roots: ['src', 'console/src'],
    extensions: ['.ts', '.tsx'],
    remediation:
      'use src/lib/phone.ts (isPhoneLocal/normalizePhone/normalizePhoneE164) for phone shape checks and formatting',
    allowlist: [
      {
        file: 'src/core/admin.ts',
        reason:
          'three `+${normalizePhoneE164(…)}` compositions build E.164-with-plus for SMS JID lookups; phone.ts exposes no plus-format primitive yet — extract one and migrate (W1.5 debt).',
      },
      {
        file: 'src/core/chat-display-name.ts',
        reason:
          'owner-facing `+${shape.phoneDigits}` render inside the display-name SSOT module; migrate to a phone.ts plus-formatter when extracted (same debt as admin.ts).',
      },
      {
        file: 'console/src/lib/text-utils.ts',
        reason:
          'browser fork of phone plus-formatting (the console bundle cannot import backend src/lib/phone.ts); already NOTE\'d in phone.ts. Kept as a fork by design.',
      },
    ],
    findMatches: (stripped) => [
      ...regexMatches(
        stripped,
        PHONE_ANCHORED_SHAPE_RE,
        'anchored phone-shape regex literal — use isPhoneLocal (or justify a distinct wire contract)',
      ),
      ...regexMatches(
        stripped,
        PHONE_PLUS_TEMPLATE_RE,
        "`+${…phone…}` plus-formatting — use a src/lib/phone.ts formatter",
      ),
    ],
  },
  {
    id: 'arch.ssot-presentation-literals',
    ssotModules: ['src/runtimes/agent/command-registry.ts'],
    roots: ['src'],
    extensions: ['.ts'],
    remediation:
      'compose PASSTHROUGH_PHRASE from src/runtimes/agent/command-registry.ts (GATE_PRESENTATION class) instead of re-typing the phrase',
    allowlist: [],
    findMatches: (stripped) =>
      regexMatches(
        stripped,
        PASSTHROUGH_RE,
        'user-facing pass-through phrase forked as a literal — compose PASSTHROUGH_PHRASE from command-registry.ts',
      ),
  },
];

// ---------------------------------------------------------------------------
// File walking + scanning
// ---------------------------------------------------------------------------

function walkFiles(
  root: string,
  dir: string,
  extensions: readonly string[],
  acc: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(root, full, extensions, acc);
    } else if (
      extensions.some((ext) => entry.endsWith(ext))
      && !entry.endsWith('.test.ts')
      && !entry.endsWith('.test.tsx')
      && !entry.endsWith('.d.ts')
    ) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/** Scan one file's content under one rule. Exported for the companion test. */
export function scanFileForRule(
  rule: SsotRuleSpec,
  relPath: string,
  content: string,
): SsotFinding[] {
  const normalized = relPath.split(path.sep).join('/');
  if (rule.ssotModules.includes(normalized)) return [];
  const stripped = stripComments(content);
  const allowlisted = rule.allowlist.some((entry) => entry.file === normalized);
  return rule.findMatches(stripped).map((m) => ({
    rule: rule.id,
    file: normalized,
    line: lineOfIndex(content, m.index),
    allowlisted,
    detail: m.detail,
  }));
}

/** Scan the repo under one rule. */
export function scanRepoForRule(cwd: string, rule: SsotRuleSpec): SsotFinding[] {
  const findings: SsotFinding[] = [];
  for (const root of rule.roots) {
    const rootAbs = path.join(cwd, root);
    const files: string[] = [];
    walkFiles(cwd, rootAbs, rule.extensions, files);
    for (const rel of files) {
      let content: string;
      try {
        content = readFileSync(path.join(cwd, rel), 'utf8');
      } catch {
        continue;
      }
      findings.push(...scanFileForRule(rule, rel, content));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Ratchet evaluation (shared with scripts/ring-boundary-guard.ts)
// ---------------------------------------------------------------------------

export type RatchetStatus =
  | 'ok'
  | 'missing-baseline'
  | 'above-baseline'
  | 'ratchet-down-required';

export interface RatchetVerdict {
  ruleId: string;
  status: RatchetStatus;
  count: number;
  baseline: number | undefined;
  message: string;
}

export const BASELINE_PATH = '.claude/fitness/baseline.json';
export const TAXONOMY_DOC_PATH = 'docs/architecture/fitness-taxonomy.md';

interface BaselineFile {
  rules?: Record<string, { violationCount?: number }>;
}

/** Read a rule's ratchet count from .claude/fitness/baseline.json (fail-closed:
 *  a missing/corrupt entry is a failure, never a silent pass). */
export function readBaselineCount(cwd: string, ruleId: string): number | undefined {
  const raw = readFileSync(path.join(cwd, BASELINE_PATH), 'utf8');
  const parsed = JSON.parse(raw) as BaselineFile;
  const value = parsed.rules?.[ruleId]?.violationCount;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Read a rule's twin count row from docs/architecture/fitness-taxonomy.md
 *  (`| \`<id>\` | <count> | …`). Returns undefined when the row is absent. */
export function readTaxonomyDocCount(cwd: string, ruleId: string): number | undefined {
  const doc = readFileSync(path.join(cwd, TAXONOMY_DOC_PATH), 'utf8');
  const escaped = ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = doc.match(new RegExp(`^\\|\\s*\`${escaped}\`\\s*\\|\\s*(\\d+)\\s*\\|`, 'm'));
  return row?.[1] !== undefined ? Number(row[1]) : undefined;
}

export function evaluateRatchet(
  ruleId: string,
  count: number,
  baseline: number | undefined,
  remediation: string,
): RatchetVerdict {
  if (baseline === undefined) {
    return {
      ruleId,
      status: 'missing-baseline',
      count,
      baseline,
      message:
        `${ruleId}: no violationCount baseline entry in ${BASELINE_PATH} — add one (current count: ${count}) plus the twin row in ${TAXONOMY_DOC_PATH}`,
    };
  }
  if (count > baseline) {
    return {
      ruleId,
      status: 'above-baseline',
      count,
      baseline,
      message:
        `${ruleId}: ${count} violation(s) vs baseline ${baseline} — new ad-hoc reimplementation(s); ${remediation}, or (only if genuinely out of scope) add a justified allowlist row and consciously bump BOTH baseline twins`,
    };
  }
  if (count < baseline) {
    return {
      ruleId,
      status: 'ratchet-down-required',
      count,
      baseline,
      message:
        `${ruleId}: violations shrank (${baseline} → ${count}). RATCHET DOWN in this same commit: set rules["${ruleId}"].violationCount=${count} in ${BASELINE_PATH} AND the matching count row in ${TAXONOMY_DOC_PATH}; drop any allowlist row whose site is gone`,
    };
  }
  return {
    ruleId,
    status: 'ok',
    count,
    baseline,
    message:
      count === 0
        ? `${ruleId}: 0 violations (zero baseline — pure block)`
        : `${ruleId}: ${count} violation(s), at baseline (recorded debt)`,
  };
}

// ---------------------------------------------------------------------------
// Rule run: findings + ratchet + twin-doc check
// ---------------------------------------------------------------------------

export interface RuleRunResult {
  ruleId: string;
  findings: SsotFinding[];
  nonAllowlisted: SsotFinding[];
  verdict: RatchetVerdict;
  twinDocMismatch: string | null;
  ok: boolean;
}

export function runRule(cwd: string, rule: SsotRuleSpec): RuleRunResult {
  const findings = scanRepoForRule(cwd, rule);
  const nonAllowlisted = findings.filter((f) => !f.allowlisted);
  const baseline = readBaselineCount(cwd, rule.id);
  const verdict = evaluateRatchet(rule.id, findings.length, baseline, rule.remediation);
  const docCount = readTaxonomyDocCount(cwd, rule.id);
  let twinDocMismatch: string | null = null;
  if (baseline !== undefined && docCount !== baseline) {
    twinDocMismatch =
      `${rule.id}: twin-doc mismatch — ${BASELINE_PATH} says ${baseline}, ` +
      `${TAXONOMY_DOC_PATH} row says ${docCount ?? 'MISSING'}; the two must move together`;
  }
  const ok = verdict.status === 'ok' && nonAllowlisted.length === 0 && twinDocMismatch === null;
  return { ruleId: rule.id, findings, nonAllowlisted, verdict, twinDocMismatch, ok };
}

export function runAllRules(cwd: string): RuleRunResult[] {
  return SSOT_RULES.map((rule) => runRule(cwd, rule));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const cwd = process.cwd();
  const results = runAllRules(cwd);
  let failed = false;
  for (const result of results) {
    if (result.ok) {
      console.log(`ssot-pattern-guard: ${result.verdict.message}`);
      continue;
    }
    failed = true;
    if (result.nonAllowlisted.length > 0) {
      const rule = SSOT_RULES.find((r) => r.id === result.ruleId)!;
      console.error(
        `ssot-pattern-guard: ${result.ruleId}: ${result.nonAllowlisted.length} finding(s) outside the allowlist — ${rule.remediation}:`,
      );
      for (const f of result.nonAllowlisted) {
        console.error(`  ${f.file}:${f.line} ${f.detail}`);
      }
    }
    if (result.verdict.status !== 'ok') {
      console.error(`ssot-pattern-guard: ${result.verdict.message}`);
      for (const f of result.findings) {
        console.error(`  ${f.file}:${f.line}${f.allowlisted ? ' [allowlisted]' : ''} ${f.detail}`);
      }
    }
    if (result.twinDocMismatch) {
      console.error(`ssot-pattern-guard: ${result.twinDocMismatch}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
