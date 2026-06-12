/**
 * fitness/outbox-direct-write — registry rule `invariant.outbox-env-gated`.
 *
 * Warns when production code writes to the bot-errors outbox (or its
 * `.local/state/bot-errors` parent) using a *hardcoded path literal* instead of
 * routing through the environment-aware resolver
 * (`resolveBotErrorsOutbox()` / `botErrorsOutboxDir()`).
 *
 * Why this shape, and not "any write without an inline NODE_ENV guard":
 * the env/test gating in this codebase is CENTRALIZED in the resolver, which
 * redirects writes to a sandbox when a test signal (VITEST/JEST/NODE_ENV=test)
 * is present (src/lib/bot-errors-outbox.ts). The two legitimate write sites
 * (`writeJsonAtomic`, `writeBotErrorsEvent`) take their path from the resolver,
 * so a blanket "inline guard missing" rule would flag BOTH of them — a
 * false-positive storm (~46% of the alert corpus is alert-emitter noise, so
 * over-flagging here is exactly the failure we must avoid).
 *
 * The actual misconception (Rank-2 finding) is *writing to the prod outbox
 * directly* — a `writeFileSync('~/.local/state/bot-errors/outbox/...')` or
 * `appendFileSync(join(homedir(), '.local', 'state', 'bot-errors', ...))` that
 * never passes through the resolver and therefore lands in the PROD outbox even
 * under VITEST. That is a deterministic, low-false-positive AST shape: a write
 * call whose path argument lexically contains the outbox sentinel and does NOT
 * mention the resolver.
 *
 * Heuristic and advisory (`warn`) by design. Clean HEAD yields zero findings
 * because every real write derives its path from `resolveBotErrorsOutbox()`.
 *
 * Source: audit:detector-misconceptions#alert-emitter-not-env-gated,
 *         feedback:dry_run_purity_run_level_test,
 *         feedback:shared_structure_consumer_semantics.
 */

// fs write sinks that land bytes on disk at a caller-supplied path.
const WRITE_SINKS = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'createWriteStream',
  'openSync', // openSync(path, 'a'|'w') is a write intent
]);

// The outbox sentinel: any path literal naming the bot-errors state/outbox dir.
// Matches both the joined-segment form ('.local','state','bot-errors') and the
// slash form ('.local/state/bot-errors', 'bot-errors/outbox').
const OUTBOX_SENTINEL = /bot-errors[\/'"\s,)]*\b(outbox|state)\b|['"]bot-errors['"]|state[\/'",\s]+bot-errors/i;

// Resolver references that make a write legitimate (path came from the
// env-aware resolver, so test-redirect already applied).
const RESOLVER_REF = /\b(resolveBotErrorsOutbox|botErrorsOutboxDir|outboxResolution|writefailDir|liveOutboxCandidates)\b/;

function calleeName(node) {
  const callee = node.callee;
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return '';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn when production code writes to the bot-errors outbox via a hardcoded path literal instead of the env-aware resolver (resolveBotErrorsOutbox).',
    },
    schema: [],
    messages: {
      directWrite:
        'Write targets the bot-errors outbox via a hardcoded path literal. Under VITEST/NODE_ENV=test this lands in the PROD outbox because it bypasses resolveBotErrorsOutbox()/botErrorsOutboxDir(). Derive the path from the resolver so the test-redirect applies.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      /** @param {import('estree').CallExpression} node */
      CallExpression(node) {
        const name = calleeName(node);
        if (!WRITE_SINKS.has(name)) return;

        const pathArg = node.arguments[0];
        if (!pathArg) return;

        const argText = sourceCode.getText(pathArg);
        if (!OUTBOX_SENTINEL.test(argText)) return;

        // If the path expression (or an obviously-local binding it references)
        // flows from the resolver, this is a legitimate write — skip.
        if (RESOLVER_REF.test(argText)) return;

        // Widen the safe check: if the resolver is referenced anywhere in the
        // immediately-enclosing function, treat the write as resolver-derived
        // (covers `const outbox = resolveBotErrorsOutbox().outbox; ...
        // writeFileSync(join(outbox, ...))`). This is the dominant clean shape.
        let fnNode = node;
        while (fnNode && !/Function/.test(fnNode.type)) fnNode = fnNode.parent;
        if (fnNode) {
          const fnText = sourceCode.getText(fnNode);
          if (RESOLVER_REF.test(fnText)) return;
        }

        context.report({ node, messageId: 'directWrite' });
      },
    };
  },
};
