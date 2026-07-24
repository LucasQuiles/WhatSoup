import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQLITE_NUMERIC_LITERAL =
  /^\s*[+-]?\s*(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i;
const SQLITE_NUMERIC_PREFIX =
  /^\s*[+-]?\s*(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i;
const CANONICAL_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/lib/sqlite-constants.ts',
);

function isCanonicalSource(filename) {
  return resolve(filename) === CANONICAL_SOURCE;
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

function findVariable(sourceCode, node) {
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return undefined;
}

function importedBinding(sourceCode, node, moduleName, importedName) {
  const variable = findVariable(sourceCode, node);
  return variable?.defs.some((candidate) => {
    if (
      candidate.type !== 'ImportBinding'
      || candidate.parent?.type !== 'ImportDeclaration'
      || candidate.parent.source.value !== moduleName
      || candidate.node.type !== 'ImportSpecifier'
    ) {
      return false;
    }
    const imported = candidate.node.imported;
    return imported.type === 'Identifier'
      ? imported.name === importedName
      : imported.value === importedName;
  }) ?? false;
}

function namespaceImportBinding(sourceCode, node, moduleName) {
  const variable = findVariable(sourceCode, node);
  return variable?.defs.some((candidate) =>
    candidate.type === 'ImportBinding'
    && candidate.parent?.type === 'ImportDeclaration'
    && candidate.parent.source.value === moduleName
    && candidate.node.type === 'ImportNamespaceSpecifier'
  ) ?? false;
}

function outerExpression(node) {
  let current = node;
  while (
    current.parent
    && (
      (
        current.parent.type === 'TSAsExpression'
        || current.parent.type === 'TSTypeAssertion'
        || current.parent.type === 'TSNonNullExpression'
        || current.parent.type === 'TSSatisfiesExpression'
        || current.parent.type === 'ChainExpression'
      )
      && current.parent.expression === current
    )
  ) {
    current = current.parent;
  }
  return current;
}

function memberRoot(node) {
  let current = outerExpression(node);
  while (
    current.parent?.type === 'MemberExpression'
    && current.parent.object === current
  ) {
    current = outerExpression(current.parent);
  }
  return current;
}

function aliasVariable(sourceCode, node) {
  const expression = outerExpression(node);
  const declarator = expression.parent;
  if (
    declarator?.type !== 'VariableDeclarator'
    || declarator.init !== expression
    || declarator.id.type !== 'Identifier'
    || declarator.parent?.type !== 'VariableDeclaration'
    || declarator.parent.kind !== 'const'
  ) {
    return undefined;
  }
  return findVariable(sourceCode, declarator.id);
}

function isObjectMutationCall(node) {
  const expression = outerExpression(node);
  const call = expression.parent;
  if (
    call?.type !== 'CallExpression'
    || call.arguments[0] !== expression
    || call.callee.type !== 'MemberExpression'
    || call.callee.computed
    || call.callee.object.type !== 'Identifier'
    || call.callee.property.type !== 'Identifier'
  ) {
    return false;
  }
  const owner = call.callee.object.name;
  const method = call.callee.property.name;
  return (
    owner === 'Object'
    && (
      method === 'assign'
      || method === 'defineProperty'
      || method === 'defineProperties'
      || method === 'setPrototypeOf'
    )
  ) || (owner === 'Reflect' && method === 'defineProperty');
}

function bindingHasUnsafeMutation(sourceCode, rootVariable) {
  const variables = new Set([rootVariable]);
  const queue = [rootVariable];

  while (queue.length > 0) {
    const variable = queue.shift();
    for (const reference of variable.references) {
      const identifier = reference.identifier;
      const alias = aliasVariable(sourceCode, identifier);
      if (alias && !variables.has(alias)) {
        variables.add(alias);
        queue.push(alias);
      }
    }
  }

  for (const variable of variables) {
    for (const reference of variable.references) {
      const identifier = reference.identifier;
      const target = memberRoot(identifier);
      const parent = target.parent;
      if (
        (
          parent?.type === 'AssignmentExpression'
          && parent.left === target
        )
        || (
          parent?.type === 'UpdateExpression'
          && parent.argument === target
        )
        || (
          parent?.type === 'UnaryExpression'
          && parent.operator === 'delete'
          && parent.argument === target
        )
        || isObjectMutationCall(identifier)
      ) {
        return true;
      }
    }
  }
  return false;
}

function normalizedSqlStatements(sql) {
  const statements = [];
  let statement = '';
  let index = 0;
  let closingQuote;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (closingQuote) {
      statement += character;
      if (character === closingQuote) {
        if (next === closingQuote) {
          statement += next;
          index += 2;
          continue;
        }
        closingQuote = undefined;
      }
      index += 1;
      continue;
    }

    if (
      character === "'"
      || character === '"'
      || character === '`'
      || character === '['
    ) {
      closingQuote = character === '[' ? ']' : character;
      statement += character;
      index += 1;
      continue;
    }

    if (character === '/' && next === '*') {
      statement += ' ';
      index += 2;
      while (
        index < sql.length
        && !(sql[index] === '*' && sql[index + 1] === '/')
      ) {
        if (sql[index] === '\n' || sql[index] === '\r') {
          statement += sql[index];
        }
        index += 1;
      }
      if (index < sql.length) index += 2;
      continue;
    }

    if (character === '-' && next === '-') {
      statement += ' ';
      index += 2;
      while (
        index < sql.length
        && sql[index] !== '\n'
        && sql[index] !== '\r'
      ) {
        index += 1;
      }
      continue;
    }

    if (character === ';') {
      statements.push(statement);
      statement = '';
      index += 1;
      continue;
    }

    statement += character;
    index += 1;
  }

  statements.push(statement);
  return statements;
}

function quotedSqlToken(rawValue) {
  const value = rawValue.trimStart();
  const openingQuote = value[0];
  const closingQuote = openingQuote === '[' ? ']' : openingQuote;
  if (
    openingQuote !== "'"
    && openingQuote !== '"'
    && openingQuote !== '`'
    && openingQuote !== '['
  ) {
    return undefined;
  }

  let decoded = '';
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character !== closingQuote) {
      decoded += character;
      continue;
    }
    if (value[index + 1] === closingQuote) {
      decoded += closingQuote;
      index += 1;
      continue;
    }
    return {
      value: decoded,
      rest: value.slice(index + 1),
    };
  }
  return undefined;
}

function decodedQuotedValue(rawValue) {
  const token = quotedSqlToken(rawValue);
  return token && token.rest.trim() === '' ? token.value : undefined;
}

function sqlIdentifier(rawValue) {
  const value = rawValue.trimStart();
  const quoted = quotedSqlToken(value);
  if (quoted) return quoted;
  const match = value.match(/^[a-z_][a-z0-9_]*/i);
  return match
    ? {
      value: match[0],
      rest: value.slice(match[0].length),
    }
    : undefined;
}

function isNumericPragmaValue(rawValue) {
  const quoted = decodedQuotedValue(rawValue);
  return quoted === undefined
    ? SQLITE_NUMERIC_LITERAL.test(rawValue)
    : SQLITE_NUMERIC_PREFIX.test(quoted);
}

function isNumericBusyTimeoutStatement(statement) {
  const pragma = statement.match(/^\s*PRAGMA\b([\s\S]*)$/i);
  if (!pragma) return false;

  const firstIdentifier = sqlIdentifier(pragma[1]);
  if (!firstIdentifier) return false;
  let pragmaName = firstIdentifier.value;
  let remainder = firstIdentifier.rest;
  const schemaSeparator = remainder.match(/^\s*\./);
  if (schemaSeparator) {
    const secondIdentifier = sqlIdentifier(
      remainder.slice(schemaSeparator[0].length),
    );
    if (!secondIdentifier) return false;
    pragmaName = secondIdentifier.value;
    remainder = secondIdentifier.rest;
  }
  if (pragmaName.toLowerCase() !== 'busy_timeout') return false;

  const configuration = remainder.match(/^\s*(=|\()([\s\S]*)$/);
  if (!configuration) return false;
  const [, delimiter, rawValue] = configuration;
  remainder = rawValue;
  if (delimiter === '=') return isNumericPragmaValue(remainder);
  const trimmed = remainder.trim();
  if (!trimmed.endsWith(')')) return false;
  return isNumericPragmaValue(trimmed.slice(0, -1));
}

function containsNumericBusyTimeoutPragma(sql) {
  return normalizedSqlStatements(sql).some(isNumericBusyTimeoutStatement);
}

function constInitializer(sourceCode, node, seen) {
  const variable = findVariable(sourceCode, node);
  if (!variable || seen.has(variable)) return undefined;
  const definition = variable.defs.find((candidate) =>
    candidate.type === 'Variable'
    && candidate.parent?.type === 'VariableDeclaration'
    && candidate.parent.kind === 'const'
    && candidate.node.type === 'VariableDeclarator'
    && candidate.node.init
  );
  if (!definition) return undefined;
  return {
    node: definition.node.init,
    seen: new Set([...seen, variable]),
    variable,
  };
}

function staticValue(sourceCode, rawNode, seen = new Set()) {
  const node = unwrapExpression(rawNode);
  if (node.type === 'Literal') {
    return typeof node.value === 'string' || typeof node.value === 'number'
      ? node.value
      : undefined;
  }
  if (node.type === 'Identifier') {
    const initializer = constInitializer(sourceCode, node, seen);
    return initializer
      ? staticValue(sourceCode, initializer.node, initializer.seen)
      : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
      if (index >= node.expressions.length) continue;
      const expressionValue = staticValue(
        sourceCode,
        node.expressions[index],
        seen,
      );
      if (expressionValue === undefined) return undefined;
      value += String(expressionValue);
    }
    return value;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticValue(sourceCode, node.left, seen);
    const right = staticValue(sourceCode, node.right, seen);
    if (left === undefined || right === undefined) return undefined;
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left) + String(right);
    }
    return left + right;
  }
  return undefined;
}

function staticStringShape(sourceCode, rawNode, filename, seen = new Set()) {
  const node = unwrapExpression(rawNode);
  const value = staticValue(sourceCode, node, seen);
  if (value !== undefined) return String(value);
  if (node.type === 'Identifier') {
    const importedName = canonicalImportName(sourceCode, node, filename);
    if (
      importedName === 'SQLITE_BUSY_TIMEOUT_MS'
      || importedName === 'SQLITE_BUSY_TIMEOUT_PRAGMA'
    ) {
      return importedName;
    }
    const initializer = constInitializer(sourceCode, node, seen);
    return initializer
      ? staticStringShape(
        sourceCode,
        initializer.node,
        filename,
        initializer.seen,
      )
      : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    let shape = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      shape += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
      if (index >= node.expressions.length) continue;
      shape += staticStringShape(
        sourceCode,
        node.expressions[index],
        filename,
        seen,
      ) ?? '0';
    }
    return shape;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return (staticStringShape(sourceCode, node.left, filename, seen) ?? '0')
      + (staticStringShape(sourceCode, node.right, filename, seen) ?? '0');
  }
  return undefined;
}

function isDatabaseSyncConstructor(sourceCode, node) {
  if (node.type !== 'NewExpression') return false;
  if (node.callee.type === 'Identifier') {
    return importedBinding(
      sourceCode,
      node.callee,
      'node:sqlite',
      'DatabaseSync',
    );
  }
  return node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object.type === 'Identifier'
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'DatabaseSync'
    && namespaceImportBinding(sourceCode, node.callee.object, 'node:sqlite');
}

function propertyName(sourceCode, property) {
  if (property.type !== 'Property') return undefined;
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  const value = staticValue(sourceCode, property.key);
  return typeof value === 'string' ? value : undefined;
}

function isSqlSinkCall(sourceCode, node) {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrapExpression(node.callee);
  if (callee.type !== 'MemberExpression') return false;
  if (!callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name === 'exec' || callee.property.name === 'prepare';
  }
  const name = staticValue(sourceCode, callee.property);
  return name === 'exec' || name === 'prepare';
}

function canonicalImportName(sourceCode, node, filename) {
  const variable = findVariable(sourceCode, node);
  const definition = variable?.defs.find((candidate) =>
    candidate.type === 'ImportBinding'
    && candidate.node.type === 'ImportSpecifier'
    && candidate.parent?.type === 'ImportDeclaration'
  );
  if (!definition) return undefined;
  const source = definition.parent.source.value;
  if (typeof source !== 'string') return undefined;
  if (resolve(dirname(filename), source) !== CANONICAL_SOURCE) return undefined;
  const imported = definition.node.imported;
  if (imported.type === 'Identifier') return imported.name;
  return typeof imported.value === 'string' ? imported.value : undefined;
}

function classifyTimeout(sourceCode, rawNode, filename, seen = new Set()) {
  const node = unwrapExpression(rawNode);
  if (
    node.type === 'Identifier'
    && canonicalImportName(sourceCode, node, filename) === 'SQLITE_BUSY_TIMEOUT_MS'
  ) {
    return { kind: 'canonical', node };
  }
  if (node.type === 'Identifier') {
    const initializer = constInitializer(sourceCode, node, seen);
    if (initializer) {
      return classifyTimeout(
        sourceCode,
        initializer.node,
        filename,
        initializer.seen,
      );
    }
  }
  const value = staticValue(sourceCode, node, seen);
  if (typeof value === 'number') return { kind: 'magic', node };
  return { kind: 'unknown', node };
}

function resolveOptions(sourceCode, rawNode, filename, seen = new Set()) {
  const node = unwrapExpression(rawNode);
  if (node.type === 'Identifier') {
    const initializer = constInitializer(sourceCode, node, seen);
    if (!initializer) return { kind: 'unknown', node };
    if (bindingHasUnsafeMutation(sourceCode, initializer.variable)) {
      return { kind: 'unknown', node };
    }
    return resolveOptions(sourceCode, initializer.node, filename, initializer.seen);
  }
  if (node.type !== 'ObjectExpression') return { kind: 'unknown', node };

  let timeout = { kind: 'absent', node };
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      const spread = resolveOptions(sourceCode, property.argument, filename, seen);
      if (spread.kind === 'unknown') {
        timeout = { kind: 'unknown', node: property.argument };
      } else if (spread.timeout.kind !== 'absent') {
        timeout = spread.timeout;
      }
      continue;
    }

    const name = propertyName(sourceCode, property);
    if (name === undefined) {
      timeout = { kind: 'unknown', node: property.key };
    } else if (name === 'timeout') {
      timeout = classifyTimeout(sourceCode, property.value, filename, seen);
    }
  }
  return { kind: 'known', timeout };
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require statically visible SQLite busy-timeout configuration to use the shared sqlite-constants source.',
    },
    schema: [],
    messages: {
      useConstant:
        'Use SQLITE_BUSY_TIMEOUT_PRAGMA or SQLITE_BUSY_TIMEOUT_MS from src/lib/sqlite-constants.ts instead of a numeric SQLite busy-timeout configuration.',
      unknownOptions:
        'DatabaseSync options could not be resolved statically. Use an inline object or a same-module const object with resolvable spreads so the SQLite timeout SSOT guard can verify it.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isCanonicalSource(filename)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const reportIfNumericPragma = (node) => {
      const value = staticStringShape(sourceCode, node, filename);
      if (value !== undefined && containsNumericBusyTimeoutPragma(value)) {
        context.report({ node, messageId: 'useConstant' });
      }
    };

    return {
      CallExpression(node) {
        if (!isSqlSinkCall(sourceCode, node)) return;
        const sql = node.arguments[0];
        if (sql && sql.type !== 'SpreadElement') reportIfNumericPragma(sql);
      },
      NewExpression(node) {
        if (!isDatabaseSyncConstructor(sourceCode, node)) return;
        const ambiguousSpread = node.arguments.find(
          (argument, index) => index <= 1 && argument.type === 'SpreadElement',
        );
        if (ambiguousSpread) {
          context.report({ node: ambiguousSpread, messageId: 'unknownOptions' });
          return;
        }
        const options = node.arguments[1];
        if (!options) return;
        const resolution = resolveOptions(sourceCode, options, filename);
        if (resolution.kind === 'unknown') {
          context.report({ node: resolution.node, messageId: 'unknownOptions' });
          return;
        }
        if (resolution.timeout.kind === 'magic') {
          context.report({ node: resolution.timeout.node, messageId: 'useConstant' });
        } else if (resolution.timeout.kind === 'unknown') {
          context.report({
            node: resolution.timeout.node,
            messageId: 'unknownOptions',
          });
        }
      },
    };
  },
};
