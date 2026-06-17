/**
 * fitness/unsafe-type-escape — registry rule `invariant.no-unsafe-type-escapes`.
 *
 * Autonomous agents rely on TypeScript and lint feedback as operating
 * boundaries. `any` and unbounded TypeScript suppressions erase that feedback,
 * so production code should use `unknown`, schema validation, narrowed contract
 * types, or a documented local wrapper instead.
 */

const SUPPRESSION_RE = /@ts-(?:ignore|nocheck|expect-error)\b/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn on production TypeScript type escapes that hide errors from agentic feedback loops.',
    },
    schema: [],
    messages: {
      anyType:
        'Unsafe `any` weakens the agent safety envelope. Prefer `unknown` plus a type guard/schema, or a named contract type at the service boundary.',
      suppression:
        'TypeScript suppression hides compiler feedback from unattended agents. Remove it, narrow the type, or isolate it behind a documented boundary wrapper.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    for (const comment of sourceCode.getAllComments()) {
      if (SUPPRESSION_RE.test(comment.value)) {
        context.report({ loc: comment.loc, messageId: 'suppression' });
      }
    }

    return {
      TSAnyKeyword(node) {
        context.report({ node, messageId: 'anyType' });
      },
    };
  },
};
