/**
 * fitness/approved-api-client — registry rule `arch.approved-api-client`.
 *
 * Console code should call the typed API client in `console/src/lib/api.ts`.
 * Direct component/page fetches bypass auth-ticket handling, timeouts,
 * response parsing, and the test surface agents are expected to preserve.
 */

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isConsoleSource(filePath) {
  return normalizePath(filePath).includes('/console/src/');
}

function isApprovedClient(filePath) {
  const normalized = normalizePath(filePath);
  return normalized.endsWith('/console/src/lib/api.ts');
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require console network requests to go through console/src/lib/api.ts.',
    },
    schema: [],
    messages: {
      directFetch:
        'Direct fetch in console UI bypasses the approved API client. Add or reuse a method in console/src/lib/api.ts so auth, timeout, parsing, and tests stay centralized.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isConsoleSource(filename) || isApprovedClient(filename)) return {};

    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
          context.report({ node: node.callee, messageId: 'directFetch' });
        }
      },
    };
  },
};
