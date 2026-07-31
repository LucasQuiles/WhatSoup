/**
 * fitness/fetch-timeout — registry rule `portability.fetch-timeout`.
 *
 * Warn: Calls to fetch() must include an options argument with a `signal` property
 * (e.g. `signal: AbortSignal.timeout(5000)`). Bare fetch(url) or fetch(url, {})
 * without a signal allows indefinite hangs on unresponsive hosts.
 *
 * Recognises:
 *   - fetch(url, { signal: ... })
 *   - fetch(url, init) where init contains signal
 *
 * Does NOT flag:
 *   - fetch through wrapper functions (ssrf-fetch.ts, etc)
 *   - Non-global fetch references
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'fetch() calls must include an AbortSignal timeout to prevent indefinite hangs on unresponsive hosts.',
    },
    schema: [],
    messages: {
      missingSignal:
        'fetch() without signal: add AbortSignal.timeout() as the signal option, or wrap through a timeout-enabled fetch wrapper.',
    },
  },
  create(context) {
    return {
      /** @param {import('estree').CallExpression} node */
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'fetch' &&
          node.arguments.length >= 1
        ) {
          // If there are exactly 2 args, check the second (options).
          // If there is 1 arg, it's definitely missing a timeout.
          // If there are 2+, the second should contain signal.
          if (node.arguments.length < 2) {
            context.report({ node, messageId: 'missingSignal' });
            return;
          }
          const opts = node.arguments[1];
          // Check for signal property in object literal or spread
          if (opts.type === 'ObjectExpression') {
            const hasSignal = opts.properties.some(
              (prop) =>
                prop.type === 'Property' &&
                prop.key.type === 'Identifier' &&
                prop.key.name === 'signal',
            );
            if (!hasSignal) {
              context.report({ node, messageId: 'missingSignal' });
            }
          } else if (opts.type === 'Identifier' || opts.type === 'MemberExpression') {
            // Variable reference — hard to statically prove it contains signal.
            // Skip (the global guard or mechanical check will catch real violations).
          } else {
            // Spread or other expression — can't statically verify.
            // The mechanical guard (portability.platform-paths-guarded) provides
            // a runtime fallback for non-trivial patterns.
          }
        }
      },
    };
  },
};
