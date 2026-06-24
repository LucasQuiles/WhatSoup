/**
 * fitness/fail-closed-scanner — registry rule `invariant.fail-closed-scanner`.
 *
 * Warns when a `catch` block silently returns an empty result (`return []` /
 * `return {}` / `return new Map()` / `return new Set()`) without surfacing the
 * failure. A scanner/gate that swallows a parse or read error and returns "no
 * findings" fails OPEN — an unauditable surface skates past the check
 * (feedback:audit_scanners_fail_closed).
 *
 * A catch is considered fail-CLOSED (and not flagged) when its body does any of:
 *   - `throw` (rethrow or new error)
 *   - assign `process.exitCode`
 *   - call something whose callee name looks like it records/pushes/emits an
 *     issue or logs an error (push, report, emit, record, logError,
 *     console.error, log.error, logger.error)
 *   - return a non-empty value (a real fallback the author chose deliberately)
 *
 * Heuristic and advisory by design: it targets the specific "return empty on
 * error" fail-open shape, and the safe-shape detectors above keep false
 * positives low. Scoped to scripts/ by the flat config (where scanners live).
 */

const EMPTY_RETURNS = (arg) => {
  if (!arg) return false; // bare `return;`
  if (arg.type === 'ArrayExpression' && arg.elements.length === 0) return true;
  if (arg.type === 'ObjectExpression' && arg.properties.length === 0) return true;
  if (
    arg.type === 'NewExpression' &&
    arg.callee.type === 'Identifier' &&
    (arg.callee.name === 'Map' || arg.callee.name === 'Set') &&
    (!arg.arguments || arg.arguments.length === 0)
  ) {
    return true;
  }
  return false;
};

const SURFACING_CALLEES = /^(push|report|emit|record|throw|logError|fail|exit)$/i;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn when a catch block silently returns an empty result instead of surfacing the failure (fail-open scanner).',
    },
    schema: [],
    messages: {
      failOpen:
        'Catch block returns an empty result without surfacing the failure. A scanner that swallows errors and returns "no findings" fails open. Rethrow, set process.exitCode, or emit an issue.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      /** @param {import('estree').CatchClause} node */
      CatchClause(node) {
        const body = node.body.body;
        let hasEmptyReturn = false;
        let hasSafeguard = false;

        const text = sourceCode.getText(node);
        // Cheap safeguard signals via source text (covers process.exitCode,
        // console.error, nested helper calls the AST walk below may miss).
        if (/process\.exitCode/.test(text) || /console\.error/.test(text) || /\blog(?:ger)?\.error\s*\(/.test(text)) {
          hasSafeguard = true;
        }

        const walk = (nodes) => {
          for (const stmt of nodes) {
            if (!stmt) continue;
            if (stmt.type === 'ThrowStatement') hasSafeguard = true;
            if (stmt.type === 'ReturnStatement') {
              if (EMPTY_RETURNS(stmt.argument)) hasEmptyReturn = true;
              else if (stmt.argument) hasSafeguard = true; // non-empty fallback
            }
            if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'CallExpression') {
              const callee = stmt.expression.callee;
              const name =
                callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
                  ? callee.property.name
                  : callee.type === 'Identifier'
                    ? callee.name
                    : '';
              if (SURFACING_CALLEES.test(name)) hasSafeguard = true;
            }
            // Shallow recurse into block-ish children.
            if (stmt.type === 'IfStatement') {
              if (stmt.consequent?.body) walk(stmt.consequent.body);
              else if (stmt.consequent) walk([stmt.consequent]);
              if (stmt.alternate?.body) walk(stmt.alternate.body);
              else if (stmt.alternate) walk([stmt.alternate]);
            }
            if (stmt.type === 'BlockStatement') walk(stmt.body);
          }
        };
        walk(body);

        if (hasEmptyReturn && !hasSafeguard) {
          context.report({ node, messageId: 'failOpen' });
        }
      },
    };
  },
};
