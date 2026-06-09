/**
 * fitness/god-class — registry rule `arch.god-class`.
 *
 * Warns when a single class is BOTH too long AND owns too many methods. The
 * composite (AND, not OR) is deliberate: a long data-table class or a class with
 * many tiny accessors is not the smell the rule targets. The smell is a class
 * that is large *and* method-dense — one unit owning many responsibilities
 * (the AgentRuntime poll+seq+gate+compact case from the retrospective).
 *
 * Thresholds come from the registry rule's params (maxClassLines, maxMethods);
 * the flat config passes them as options so the registry stays the single
 * source of truth.
 *
 * Severity is configured to 'warn' by the config — this rule never errors on its
 * own; it reports and lets the config decide.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Warn when a class exceeds BOTH the max line span and the max method count (god class).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          maxClassLines: { type: 'number' },
          maxMethods: { type: 'number' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      godClass:
        "Class '{{name}}' spans {{lines}} lines with {{methods}} methods, exceeding both thresholds (maxClassLines={{maxClassLines}}, maxMethods={{maxMethods}}). Split responsibilities into focused units.",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const maxClassLines = options.maxClassLines ?? 1200;
    const maxMethods = options.maxMethods ?? 80;

    /**
     * @param {import('estree').Class & { loc: import('estree').SourceLocation }} node
     */
    function checkClass(node) {
      if (!node.body || !node.loc) return;
      const lines = node.loc.end.line - node.loc.start.line + 1;
      const methods = node.body.body.filter(
        (member) =>
          member.type === 'MethodDefinition' ||
          (member.type === 'PropertyDefinition' &&
            member.value &&
            (member.value.type === 'FunctionExpression' ||
              member.value.type === 'ArrowFunctionExpression')),
      ).length;

      // Composite: BOTH thresholds must be exceeded.
      if (lines > maxClassLines && methods > maxMethods) {
        const name = node.id?.name ?? '<anonymous>';
        context.report({
          node: node.id ?? node,
          messageId: 'godClass',
          data: { name, lines, methods, maxClassLines, maxMethods },
        });
      }
    }

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
};
