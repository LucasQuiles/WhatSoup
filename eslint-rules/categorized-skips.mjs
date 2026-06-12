/**
 * fitness/categorized-skips — registry rule `test.skip-categorization`.
 *
 * Advisory: a skipped test must declare WHY it is skipped, so an
 * environment-dependent skip (missing binary, platform shim) is never confused
 * with a timing-dependent skip (sampler interval, load race) — they hide
 * different bugs (feedback:skip_categorization, feedback:masked_test_signal).
 *
 * Covers `it.skip` / `test.skip` / `describe.skip` and the Vitest conditional
 * forms `it.skipIf(...)` / `it.runIf(...)` (and `test.`/`describe.` variants).
 * A skip is "categorized" when an adjacent comment (same line or the line above)
 * contains `@skip-env` or `@skip-timing`. Uncategorized → warn.
 *
 * This is NOT the raw-skip blocker — scripts/repo-hygiene-guard.ts already blocks
 * committed `.skip` via `skipped-test`. This rule adds intent taxonomy and the
 * `skipIf` surface the hygiene guard does not categorize.
 */

const SKIP_PROPS = new Set(['skip', 'skipIf', 'runIf']);
const SKIP_ROOTS = new Set(['it', 'test', 'describe']);
const CATEGORY_RE = /@skip-(env|timing)\b/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require skipped tests to declare an @skip-env or @skip-timing reason so environment and timing skips are not conflated.',
    },
    schema: [],
    messages: {
      uncategorized:
        "Skipped test is not categorized. Add an adjacent comment with '@skip-env' (missing binary/platform) or '@skip-timing' (sampler/load race) so the skip's cause is explicit.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** @param {import('estree').Node} node */
    function hasCategoryComment(node) {
      // Look at comments before the statement (line above) and trailing on the
      // same line.
      const before = sourceCode.getCommentsBefore(node);
      const after = sourceCode.getCommentsAfter(node);
      const stmt = node.expression ? node : node;
      const all = [...before, ...after];
      // Also scan any comment on the same start line as the call.
      const line = node.loc?.start.line;
      for (const c of sourceCode.getAllComments()) {
        if (c.loc && (c.loc.start.line === line || c.loc.end.line === line)) all.push(c);
      }
      return all.some((c) => CATEGORY_RE.test(c.value));
    }

    return {
      /** @param {import('estree').MemberExpression} node */
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          SKIP_ROOTS.has(node.object.name) &&
          node.property.type === 'Identifier' &&
          SKIP_PROPS.has(node.property.name)
        ) {
          // Report against the enclosing statement so comment lookup is stable.
          let stmt = node;
          while (
            stmt.parent &&
            stmt.parent.type !== 'ExpressionStatement' &&
            stmt.parent.type !== 'Program'
          ) {
            stmt = stmt.parent;
          }
          const target = stmt.parent?.type === 'ExpressionStatement' ? stmt.parent : node;
          if (!hasCategoryComment(target)) {
            context.report({ node, messageId: 'uncategorized' });
          }
        }
      },
    };
  },
};
