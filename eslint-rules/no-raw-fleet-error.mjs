/**
 * no-raw-fleet-error — static guard for #2517.
 *
 * Rejects direct use of `errorMessage()` and `.message` on caught error
 * variables in fleet route response construction. After the #2517 migration,
 * all fleet route error responses must go through the response error
 * projection module. Raw exception prose, paths, commands, and stderr must
 * never enter JSON or SSE responses.
 *
 * Allowed escape hatch: `errorMessage()` is permitted inside functions whose
 * name starts with a diagnostic prefix (e.g. `serviceErrorMessage`), because
 * those classify errors internally without constructing responses.
 */
const DIAGNOSTIC_PREFIXES = ['service', 'classify', 'diagnose', 'isBenign'];

function isDiagnosticFunction(context, node) {
  let current = node;
  while (current) {
    if (
      current.type === 'FunctionDeclaration'
      || current.type === 'FunctionExpression'
      || current.type === 'ArrowFunctionExpression'
    ) {
      if (current.id?.name) {
        return DIAGNOSTIC_PREFIXES.some((prefix) =>
          current.id.name.startsWith(prefix)
        );
      }
      // Check parent for assigned/declared function names
      const parent = current.parent;
      if (parent?.type === 'VariableDeclarator' && parent.id?.name) {
        return DIAGNOSTIC_PREFIXES.some((prefix) =>
          parent.id.name.startsWith(prefix)
        );
      }
    }
    current = current.parent;
  }
  return false;
}

function isImportedFromErrorModule(context, node) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      return variable.defs.some(
        (def) =>
          def.type === 'ImportBinding' &&
          def.parent?.source?.value?.includes('error-message'),
      );
    }
    scope = scope.upper;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject raw errorMessage() and err.message in fleet route response construction (#2517).',
    },
    schema: [],
    messages: {
      noRawErrorMessage:
        'Do not use errorMessage() in fleet routes — use projectError() from response-error-projection.ts instead (#2517).',
      noRawMessage:
        'Do not use .message on error variables in fleet route responses — use projectError() from response-error-projection.ts instead (#2517).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!filename.includes('/fleet/routes/')) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        if (node.callee.name !== 'errorMessage') return;
        if (!isImportedFromErrorModule(context, node.callee)) return;
        if (isDiagnosticFunction(context, node)) return;
        context.report({ node, messageId: 'noRawErrorMessage' });
      },
    };
  },
};
