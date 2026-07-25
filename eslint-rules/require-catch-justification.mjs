/**
 * fitness/require-catch-justification — registry rule `hygiene.catch-justification`.
 *
 * SCOPE (read before relying on this): this rule catches exactly ONE shape — an
 * empty `catch {}` block (no bound variable, empty body) that lacks a justification
 * comment. The `catch {` syntax (no param) bypasses `useUnknownInCatchVariables`
 * entirely: no lint rule, no runtime guard, no TypeScript enforcement can detect
 * whether the swallow is intentional. Empty catches silently drop errors.
 *
 * RATCHET: the codebase inherited 240+ bare catches. This rule is a ratchet —
 * existing locations are locked into `catch-ratchet-baseline.json` so the rule
 * emits ZERO findings today; NEW bare catches without a justification comment are
 * flagged. The baseline is meant to be reduced over time (each removal gains a
 * justification comment or a bound variable).
 *
 * JUSTIFICATION: a bare catch is exempt if a comment immediately preceding or
 * inside the catch body matches the justification regex (intentional, by design,
 * already-exited, prior guard, ok-if). This makes the *intent* explicit at the
 * site rather than relying on the baseline alone.
 *
 * FORWARD-LOOKING: the rule prevents *growth* of the silent-swallow surface. It
 * is NOT a detector for the 240 inherited catches (those are baselined); reducing
 * them is a separate, per-sprint effort tracked in the baseline file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = resolve(RULE_DIR, 'catch-ratchet-baseline.json');

// A justification comment: makes the swallow explicit. Conservative matchers so
// a stray "// fix later" does NOT count as a justification — the author must name
// the reason class (intentional / by design / already-exited / prior guard / ok-if).
const JUSTIFICATION_RE =
  /\b(intentional|by design|already (exited|dead|finished)|prior guard|ok if|deliberately|swallow(?:s|ed)? (on purpose|by design)|noop|no-op)\b/i;

/** Read a baseline file (JSON object of "relativePath:line" → true). */
function readBaseline(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed));
    }
  } catch {
    // Missing/unreadable baseline → empty set (every bare catch is new → flagged).
  }
  return new Set();
}

/** Repo-root-relative path for the location key. Falls back to filename. */
function relativeKey(context, node) {
  const filename = context.filename ?? context.getFilename();
  const cwd = context.cwd;
  const rel = filename.startsWith(cwd)
    ? filename.slice(cwd.length + 1)
    : filename;
  return `${rel}:${node.loc.start.line}`;
}

/** Collect comment text before a node and inside its body. */
function commentText(sourceCode, node) {
  const comments = [
    ...sourceCode.getCommentsBefore(node),
    ...sourceCode.getCommentsInside(node.body),
  ];
  return comments.map((c) => c.value).join('\n');
}

/**
 * @type {import('eslint').Rule.RuleModule}
 * options[0]: { baselinePath?: string }
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag empty catch {} blocks (no bound variable) that lack a justification comment and are not in the ratchet baseline.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          baselinePath: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareCatch:
        'Empty catch block swallows errors silently and bypasses useUnknownInCatchVariables. Bind the error (catch (e)) or add a justification comment (// intentional: …).',
    },
  },
  create(context) {
    const options = context.options?.[0] ?? {};
    const baseline = readBaseline(options.baselinePath ?? DEFAULT_BASELINE);
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CatchClause(node) {
        // Only bare catch {}: no bound param AND an empty block body.
        if (node.param !== null) return;
        if (node.body.type !== 'BlockStatement') return;
        if (node.body.body.length > 0) return;

        // Exempt: explicit justification comment.
        if (JUSTIFICATION_RE.test(commentText(sourceCode, node))) return;

        // Exempt: ratchet baseline (inherited tech debt, locked, to be reduced).
        if (baseline.has(relativeKey(context, node))) return;

        context.report({ node, messageId: 'bareCatch' });
      },
    };
  },
};
