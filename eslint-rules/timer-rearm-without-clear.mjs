/**
 * fitness/timer-rearm-without-clear — registry rule `invariant.timer-rearm-without-clear`.
 *
 * Advisory: storing a timer handle in a Map value object — `someMap.set(key, { …,
 * t: setTimeout(...) })` / `setInterval(...)` — and re-arming the same key without first
 * clearing the previous entry orphans the old timer, which keeps firing. This is the
 * OperationTracker.onToolStart bug class: a replayed key overwrote the map entry while
 * its timers leaked (duplicate "Still working…" placeholders).
 *
 * Conservative by design (low false-positive): a `.set(key, {timer})` is flagged ONLY
 * when its enclosing function contains NO clear-before-set guard — i.e. no
 * `clearTimeout`/`clearInterval`, no `clear*(...)` helper call, and no `.get(...)` lookup
 * of the existing entry. Every correctly-guarded site in the codebase (operation-tracker,
 * vote-grace timers, image-coalesce buffers) retrieves + clears the prior entry, so this
 * rule passes them and fires only on the unguarded shape. It does NOT touch field-assigned
 * timers (`this.timer = setInterval(...)`), which legitimately guard via proxy flags
 * (e.g. `if (this.isTyping) return`) — that pattern is out of scope to avoid false positives.
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
