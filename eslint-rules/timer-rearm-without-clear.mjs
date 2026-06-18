/**
 * fitness/timer-rearm-without-clear — registry rule `invariant.timer-rearm-without-clear`.
 *
 * SCOPE (read before relying on this): this rule catches exactly ONE shape — a timer
 * handle written INLINE in a `Map.set` value literal: `someMap.set(key, { …, t:
 * setTimeout(...) })` / `setInterval(...)` — re-armed without first clearing the previous
 * entry, which orphans the old timer.
 *
 * It is a FORWARD-LOOKING guard. The codebase today uses the build-then-set idiom
 * (construct the value object with timer fields = null, `map.set(key, obj)`, then arm
 * timers via field assignment in a later statement/method), so this inline shape occurs
 * NOWHERE at present and the rule emits zero findings. It is therefore NOT the detector
 * for the OperationTracker.onToolStart leak — that field-assigned variant needs cross-
 * statement/type-aware dataflow a lexical lint rule can't do reliably, and is covered by
 * its own regression test (tests/runtimes/agent/operation-tracker.test.ts) plus the
 * progress-coalescing bench, not by this rule. The rule's value is preventing the inline
 * variant from being introduced later.
 *
 * Conservative by design (low false-positive): the inline `.set(key, {timer})` is flagged
 * ONLY when its enclosing function contains NO clear-before-set guard — no
 * `clearTimeout`/`clearInterval`, no `clear*(...)` helper call, and no `.get(...)` lookup.
 * Field-assigned timers (`this.timer = setInterval(...)`), which legitimately guard via
 * proxy flags (e.g. `if (this.isTyping) return`), are out of scope.
 */

const TIMER_FNS = new Set(['setTimeout', 'setInterval']);

/** @param {import('estree').Node | null | undefined} node */
function isTimerCall(node) {
  return (
    !!node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    TIMER_FNS.has(node.callee.name)
  );
}

/** True when an object literal has any property initialised to setTimeout/setInterval. */
function objectHoldsTimer(node) {
  return (
    node.type === 'ObjectExpression' &&
    node.properties.some((p) => p.type === 'Property' && isTimerCall(p.value))
  );
}

/** @param {import('eslint').Rule.Node} node */
function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === 'FunctionDeclaration' ||
      cur.type === 'FunctionExpression' ||
      cur.type === 'ArrowFunctionExpression'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

// A clear-before-set guard: an explicit timer clear, any `clear*(...)` helper call, or a
// `.get(...)` of the existing entry (the retrieve-then-clear idiom).
const GUARD_RE = /clear(Timeout|Interval)\s*\(|\bclear[A-Za-z0-9_]*\s*\(|\.get\s*\(/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag storing a timer handle in a Map value object and re-arming a key without first clearing the previous timer (orphaned-timer leak).',
    },
    schema: [],
    messages: {
      unguarded:
        "Map stores a timer handle but this function has no clear-before-set guard. Re-arming the same key orphans the previous timer (it keeps firing). Clear the existing entry first (e.g. `const prev = map.get(key); if (prev) clearTimeout(prev.timer)`).",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.property.type !== 'Identifier' || callee.property.name !== 'set') return;
        const valueArg = node.arguments[1];
        if (!valueArg || !objectHoldsTimer(valueArg)) return;

        const fn = enclosingFunction(node);
        const scopeText = fn ? sourceCode.getText(fn) : sourceCode.getText();
        if (GUARD_RE.test(scopeText)) return; // a clear/get guard is present → assume guarded

        context.report({ node, messageId: 'unguarded' });
      },
    };
  },
};
