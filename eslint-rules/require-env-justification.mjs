/**
 * fitness/require-env-justification — registry rule
 * `arch.env-read-justification` (#2192 slice 5a).
 *
 * Advisory warn mirror of the AUTHORITATIVE lexical ratchet at
 * tests/scripts/env-read-allowlist.test.ts. Both consume the shared SSOT
 * eslint-rules/env-read-allowlist.json. The vitest test blocks (curated
 * push-gate + full CI); this rule exists to surface the same discipline at
 * editor/push latency. It must never become `error`: blocking authority
 * stays with the suppression-immune test (an inline lint suppression
 * cannot shrink a lexical scan).
 *
 * Detection is deduped to ONE finding per source line so the rule's grain
 * equals the test's line grain ("one site = one non-comment source line
 * containing a process.env access") — several lines in src/ carry two
 * process.env tokens and must not double-warn.
 *
 * Exemptions, in order: (a) an `env-allowed: <reason>` marker on the same
 * line or the line above, meeting the catch-rule quality floor (>=16 chars,
 * >=3 words) — slice 5b sweeps these on; (b) otherwise the file stays silent
 * while its UNMARKED line count is within `allowedUnmarkedSites` from the
 * SSOT, which keeps the 5a transition window warn-free (zero markers,
 * unmarked == pinned == allowed).
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = resolve(RULE_DIR, 'env-read-allowlist.json');
const MARKER_RE = /env-allowed:\s*(.+)/;

function normalizePath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function parseEnvAllowlist(raw, path = '<allowlist>') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`env-read allowlist ${path} contains invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed?.rows) || parsed.rows.length === 0) {
    throw new Error(`env-read allowlist ${path} must carry a non-empty rows[] array`);
  }
  const allowed = new Map();
  for (const [index, row] of parsed.rows.entries()) {
    if (
      typeof row?.file !== 'string' || row.file.length === 0
      || !Number.isInteger(row.allowedUnmarkedSites) || row.allowedUnmarkedSites <= 0
      || typeof row.reason !== 'string' || row.reason.length === 0
    ) {
      throw new Error(`env-read allowlist ${path} row ${index} is malformed`);
    }
    allowed.set(row.file, row.allowedUnmarkedSites);
  }
  return allowed;
}

export function readEnvAllowlist(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`env-read allowlist ${path} is unreadable: ${error.message}`);
  }
  return parseEnvAllowlist(raw, path);
}

/** A comment justifies a line when it carries the marker and meets the catch-rule floor. */
export function hasMeaningfulEnvJustification(commentText) {
  const match = MARKER_RE.exec(commentText);
  if (!match) return false;
  const reason = match[1].trim();
  const words = reason.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  return reason.length >= 16 && words.length >= 3;
}

/** True when `node` is exactly the `process.env` base (dot or computed). */
function isProcessEnvBase(node) {
  if (node.type !== 'MemberExpression') return false;
  if (node.object.type !== 'Identifier' || node.object.name !== 'process') return false;
  if (node.computed) {
    return node.property.type === 'Literal' && node.property.value === 'env';
  }
  return node.property.type === 'Identifier' && node.property.name === 'env';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'process.env access outside the typed-config seam needs an env-allowed justification '
        + 'or an allowlist row (mirror of tests/scripts/env-read-allowlist.test.ts)',
    },
    schema: [
      {
        type: 'object',
        properties: { baselinePath: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      unjustifiedEnvRead:
        'Direct process.env access without justification. Route the value through the typed '
        + 'config (src/config.ts) or add an `env-allowed: <reason>` marker (>=16 chars, >=3 '
        + 'words) on this line or the line above; new sanctioned files need a reviewed row in '
        + 'eslint-rules/env-read-allowlist.json.',
    },
  },
  create(context) {
    const options = context.options?.[0] ?? {};
    const baselinePath = isAbsolute(options.baselinePath ?? '')
      ? options.baselinePath
      : resolve(context.cwd ?? process.cwd(), options.baselinePath ?? DEFAULT_BASELINE);
    const allowed = readEnvAllowlist(baselinePath);

    const filename = context.filename ?? context.getFilename();
    const absoluteFilename = isAbsolute(filename)
      ? filename
      : resolve(context.cwd ?? process.cwd(), filename);
    const repoPath = normalizePath(relative(context.cwd ?? process.cwd(), absoluteFilename));

    /** line number -> first reported AST node on that line */
    const siteLines = new Map();

    return {
      MemberExpression(node) {
        if (!isProcessEnvBase(node)) return;
        const line = node.loc.start.line;
        if (!siteLines.has(line)) siteLines.set(line, node);
      },
      'Program:exit'() {
        if (siteLines.size === 0) return;
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const justifiedLines = new Set();
        for (const comment of sourceCode.getAllComments()) {
          if (!hasMeaningfulEnvJustification(comment.value.trim())) continue;
          // Same-line trailing marker justifies its own line; a marker line
          // (comment) justifies the line directly below it.
          justifiedLines.add(comment.loc.end.line);
          justifiedLines.add(comment.loc.end.line + 1);
        }
        const unmarked = [...siteLines.entries()]
          .filter(([line]) => !justifiedLines.has(line))
          .sort(([a], [b]) => a - b);
        if (unmarked.length <= (allowed.get(repoPath) ?? 0)) return;
        for (const [, node] of unmarked) {
          context.report({ node, messageId: 'unjustifiedEnvRead' });
        }
      },
    };
  },
};
