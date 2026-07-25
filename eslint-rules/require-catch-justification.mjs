/**
 * fitness/require-catch-justification — registry rule
 * `hygiene.catch-justification`.
 *
 * A catch is justified when it performs observable handling or carries a
 * reasoned comment. Merely binding the error, adding an empty statement, or
 * spelling a no-op does not turn a swallowed failure into handling.
 *
 * The ratchet baseline is a multiset of semantic identities. Each identity is
 * the repo-relative file plus a hash of the try-block tokens. It survives
 * unrelated line and comment movement while still making edited try behavior
 * re-enter review. Duplicate identities are preserved as duplicate array
 * entries, so adding a copy of an inherited swallow exceeds the baseline.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = resolve(RULE_DIR, 'catch-ratchet-baseline.json');
const IDENTITY_RE = /^[^:\r\n]+(?:\/[^:\r\n]+)*::[a-f0-9]{64}$/;
const JUSTIFICATION_CLASS_RE =
  /\b(intentional|by design|already (?:exited|dead|finished)|prior guard|ok if|deliberately)\b\s*(?::|—|-)\s*(.+)/i;
const NOOP_CALLEES = new Set(['ignore', 'ignored', 'intentional', 'noop', 'noOp']);

function normalizePath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function parseCatchBaseline(raw, path = '<baseline>') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `catch-ratchet baseline ${path} contains invalid JSON: ${error.message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `catch-ratchet baseline ${path} must be an array of semantic identities`,
    );
  }
  for (const [index, identity] of parsed.entries()) {
    if (typeof identity !== 'string' || !IDENTITY_RE.test(identity)) {
      throw new Error(
        `catch-ratchet baseline ${path} entry ${index} is not a valid semantic identity`,
      );
    }
  }
  return parsed;
}

export function readCatchBaseline(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `catch-ratchet baseline ${path} is unreadable: ${error.message}`,
    );
  }
  return parseCatchBaseline(raw, path);
}

function countIdentities(identities) {
  const counts = new Map();
  for (const identity of identities) {
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function unwrapExpression(node) {
  if (
    node.type === 'TSAsExpression'
    || node.type === 'TSTypeAssertion'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSSatisfiesExpression'
    || node.type === 'ChainExpression'
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function isTrivialExpression(node) {
  const expression = unwrapExpression(node);
  if (
    expression.type === 'Identifier'
    || expression.type === 'Literal'
    || expression.type === 'JSXText'
  ) {
    return true;
  }
  if (expression.type === 'TemplateLiteral') {
    return expression.expressions.length === 0;
  }
  if (expression.type === 'UnaryExpression' && expression.operator === 'void') {
    return true;
  }
  if (expression.type === 'SequenceExpression') {
    return expression.expressions.every(isTrivialExpression);
  }
  return (
    expression.type === 'CallExpression'
    && expression.arguments.length === 0
    && expression.callee.type === 'Identifier'
    && NOOP_CALLEES.has(expression.callee.name)
  );
}

export function isTrivialCatchBody(body) {
  return body.body.every((statement) =>
    statement.type === 'EmptyStatement'
    || (
      statement.type === 'ExpressionStatement'
      && isTrivialExpression(statement.expression)
    ),
  );
}

export function hasMeaningfulCatchJustification(comments) {
  return comments.some((comment) => {
    const match = JUSTIFICATION_CLASS_RE.exec(comment.value.trim());
    if (!match) return false;
    const reason = match[2].trim();
    const words = reason.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
    return reason.length >= 16 && words.length >= 3;
  });
}

export function catchIdentity(context, sourceCode, node) {
  const cwd = context.cwd ?? context.getCwd?.() ?? process.cwd();
  const filename = context.filename ?? context.getFilename();
  const absoluteFilename = isAbsolute(filename) ? filename : resolve(cwd, filename);
  const repoPath = normalizePath(relative(cwd, absoluteFilename));
  if (
    repoPath.length === 0
    || repoPath === '..'
    || repoPath.startsWith('../')
  ) {
    throw new Error(
      `catch-ratchet cannot derive a repo-relative identity for ${filename}`,
    );
  }

  const tryStatement = node.parent;
  if (tryStatement?.type !== 'TryStatement') {
    throw new Error('catch-ratchet expected CatchClause parent to be TryStatement');
  }
  const tokens = sourceCode.getTokens(tryStatement.block).map((token) => [
    token.type,
    token.value,
  ]);
  const digest = createHash('sha256')
    .update(JSON.stringify(tokens))
    .digest('hex');
  return `${repoPath}::${digest}`;
}

function baselinePath(context, configured) {
  if (!configured) return DEFAULT_BASELINE;
  const cwd = context.cwd ?? context.getCwd?.() ?? process.cwd();
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

/**
 * @type {import('eslint').Rule.RuleModule}
 * options[0]: { baselinePath?: string, mode?: 'enforce' | 'report-all' }
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Flag catch blocks that swallow errors without observable handling or a reasoned justification.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          baselinePath: { type: 'string' },
          mode: { enum: ['enforce', 'report-all'] },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unjustifiedCatch:
        'Catch block swallows errors without meaningful handling or a reasoned justification. Handle the error or explain why swallowing it is safe. [catch-ratchet:{{identity}}]',
    },
  },
  create(context) {
    const options = context.options?.[0] ?? {};
    const reportAll = options.mode === 'report-all';
    const baseline = reportAll
      ? new Map()
      : countIdentities(readCatchBaseline(baselinePath(context, options.baselinePath)));
    const seen = new Map();
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CatchClause(node) {
        if (node.body.type !== 'BlockStatement' || !isTrivialCatchBody(node.body)) {
          return;
        }
        if (
          hasMeaningfulCatchJustification(sourceCode.getCommentsInside(node))
        ) {
          return;
        }

        const identity = catchIdentity(context, sourceCode, node);
        const occurrence = (seen.get(identity) ?? 0) + 1;
        seen.set(identity, occurrence);
        if (!reportAll && occurrence <= (baseline.get(identity) ?? 0)) return;

        context.report({
          node,
          messageId: 'unjustifiedCatch',
          data: { identity },
        });
      },
    };
  },
};
