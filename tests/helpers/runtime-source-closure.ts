import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export function runtimeSourceClosure(entryPath: string, sourceRoot: string): string[] {
  const pending = [resolve(sourceRoot, entryPath)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (specifier === null && ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isDynamicImport || isRequire) {
          const argument = node.arguments[0];
          const validArity = isDynamicImport
            ? node.arguments.length === 1 || node.arguments.length === 2
            : node.arguments.length === 1;
          if (!validArity || argument === undefined || !ts.isStringLiteralLike(argument)) {
            throw new Error(`unbounded runtime import in ${relative(sourceRoot, sourcePath)}`);
          }
          specifier = argument.text;
        }
      }
      if (specifier?.startsWith('.') === true) {
        const unresolved = resolve(dirname(sourcePath), specifier);
        const dependency = [unresolved, `${unresolved}.ts`, join(unresolved, 'index.ts')]
          .find((candidate) => existsSync(candidate));
        if (dependency === undefined) throw new Error(`unresolved local import in ${relative(sourceRoot, sourcePath)}`);
        pending.push(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...visited].map((path) => relative(sourceRoot, path).replaceAll('\\', '/')).sort();
}
