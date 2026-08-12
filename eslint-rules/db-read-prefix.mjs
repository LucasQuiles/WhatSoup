/**
 * db-read-prefix — enforces the `get` prefix convention for DB-read helpers
 * (#2213).
 *
 * Flags `export function load*` / `export function fetch*` when the first
 * parameter is typed `db: Database` or `db: DatabaseSync`. DB-read helpers
 * must use `get` as the canonical prefix.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "DB-read helpers must use the 'get' prefix, not 'load'/'fetch' (#2213).",
    },
    schema: [],
    messages: {
      dbReadPrefix:
        "DB-read helper must use 'get' prefix, not 'load'/'fetch'. Rename to get<Name>.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        const parent = node.parent;
        if (
          !parent ||
          (parent.type !== 'ExportNamedDeclaration' &&
            parent.type !== 'ExportDefaultDeclaration')
        )
          return;

        const name = node.id?.name;
        if (!name || !/^(load|fetch)[A-Z]/.test(name)) return;

        const firstParam = node.params?.[0];
        if (!firstParam || firstParam.type !== 'Identifier') return;

        const typeAnn = firstParam.typeAnnotation?.typeAnnotation;
        if (!typeAnn || typeAnn.type !== 'TSTypeReference') return;

        const typeName = typeAnn.typeName;
        if (!typeName || typeName.type !== 'Identifier') return;
        if (typeName.name !== 'Database' && typeName.name !== 'DatabaseSync')
          return;

        context.report({ node: node.id, messageId: 'dbReadPrefix' });
      },
    };
  },
};
