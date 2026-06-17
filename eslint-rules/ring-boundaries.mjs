/**
 * fitness/ring-boundaries — registry rule `arch.ring-boundaries`.
 *
 * Enforces the backend source dependency direction used by autonomous agents:
 * shared primitives -> domain/contracts -> adapters/runtimes -> composition.
 * Lower rings must not import higher rings. When code needs data from a higher
 * ring, move a stable type/utility down into a shared contract or route through
 * an approved service boundary.
 */

import path from 'node:path';

const RINGS = [
  { name: 'shared', level: 0 },
  { name: 'domain', level: 1 },
  { name: 'adapter', level: 2 },
  { name: 'runtime', level: 3 },
  { name: 'composition', level: 4 },
];

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function repoSourcePath(filePath) {
  const normalized = normalizePath(filePath);
  const srcIndex = normalized.indexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  return normalized;
}

function stripExtension(filePath) {
  return filePath.replace(/\.(?:m?tsx?|jsx?)$/, '');
}

function sourceValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function resolveImport(fromFile, specifier) {
  if (!specifier || specifier.startsWith('node:')) return null;
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  if (cleanSpecifier.startsWith('src/')) return normalizePath(cleanSpecifier);
  if (!cleanSpecifier.startsWith('.')) return null;

  const fromDir = path.posix.dirname(normalizePath(fromFile));
  const resolved = normalizePath(path.posix.normalize(path.posix.join(fromDir, cleanSpecifier)));
  const srcIndex = resolved.indexOf('/src/');
  if (srcIndex >= 0) return resolved.slice(srcIndex + 1);
  return resolved.startsWith('src/') ? resolved : null;
}

function ringFor(filePath) {
  const normalized = stripExtension(repoSourcePath(filePath));
  if (!normalized.startsWith('src/')) return null;

  if (
    normalized.startsWith('src/lib/') ||
    normalized === 'src/logger' ||
    normalized === 'src/errors'
  ) {
    return RINGS[0];
  }

  if (
    normalized.startsWith('src/core/') ||
    normalized.startsWith('src/transport/contract/') ||
    normalized === 'src/runtimes/types'
  ) {
    return RINGS[1];
  }

  if (normalized.startsWith('src/transport/')) return RINGS[2];

  if (
    normalized.startsWith('src/runtimes/') ||
    normalized.startsWith('src/mcp/')
  ) {
    return RINGS[3];
  }

  if (
    normalized.startsWith('src/fleet/') ||
    normalized === 'src/config' ||
    normalized === 'src/config-memory-migration' ||
    normalized === 'src/instance-loader' ||
    normalized === 'src/main' ||
    normalized === 'src/main-shutdown-policy' ||
    normalized === 'src/bootstrap' ||
    normalized === 'src/bootstrap-auth' ||
    normalized === 'src/bootstrap-common'
  ) {
    return RINGS[4];
  }

  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prevent lower backend architectural rings from importing higher rings directly.',
    },
    schema: [],
    messages: {
      invalidRing:
        "Invalid ring dependency: {{fromRing}} code must not import {{toRing}} code ({{importPath}}). Move the shared contract downward or call through an approved service/client boundary.",
    },
  },
  create(context) {
    const filename = normalizePath(context.filename ?? context.getFilename());
    const fromRing = ringFor(filename);
    if (!fromRing) return {};

    function checkSource(node, sourceNode) {
      const specifier = sourceValue(sourceNode);
      const importPath = resolveImport(filename, specifier);
      if (!importPath) return;

      const toRing = ringFor(importPath);
      if (!toRing) return;
      if (toRing.level <= fromRing.level) return;

      context.report({
        node,
        messageId: 'invalidRing',
        data: {
          fromRing: fromRing.name,
          toRing: toRing.name,
          importPath,
        },
      });
    }

    return {
      ImportDeclaration(node) {
        checkSource(node.source, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node.source, node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source, node.source);
      },
      ImportExpression(node) {
        checkSource(node.source, node.source);
      },
    };
  },
};
