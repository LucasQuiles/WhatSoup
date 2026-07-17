import { posix } from 'node:path';
import ts from 'typescript';

export interface ModuleSource {
  path: string;
  text: string;
}

export interface ModuleGraph {
  files: ReadonlySet<string>;
  runtimeEdges: ReadonlyMap<string, ReadonlySet<string>>;
  unresolvedRuntimeSpecifiers: ReadonlyMap<string, ReadonlySet<string>>;
  runtimeExports: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ReachabilityResult {
  roots: string[];
  reachable: Set<string>;
  unreachableCandidates: string[];
  unresolved: Array<{ importer: string; specifier: string }>;
}

export interface ExportOwnershipResult {
  unowned: Array<{ path: string; name: string }>;
  owned: Array<{ path: string; name: string; owners: string[] }>;
}

interface RuntimeReexport {
  specifier: string;
  kind: 'named' | 'star' | 'namespace';
  importedName?: string;
}

interface DirectRuntimeExport {
  exportedName: string;
  localName: string | null;
}

interface ParsedModule {
  path: string;
  sourceFile: ts.SourceFile;
  directExports: DirectRuntimeExport[];
  reexports: RuntimeReexport[];
}

interface DirectImportBinding {
  localName: string;
  importedName: string;
  targetPath: string;
}

interface NamespaceImportBinding {
  localName: string;
  targetPath: string;
}

function normalizePath(path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function sortedSet(values: Iterable<string>): Set<string> {
  return new Set([...values].sort());
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(source: ModuleSource): ts.SourceFile {
  const diagnostic = ts
    .transpileModule(source.text, {
      fileName: source.path,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
      },
    })
    .diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    throw new SyntaxError(`could not parse ${source.path}: ${message}`);
  }
  const sourceFile = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path),
  );
  return sourceFile;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function collectDirectRuntimeExports(sourceFile: ts.SourceFile): DirectRuntimeExport[] {
  const exports = new Map<string, string | null>();

  for (const statement of sourceFile.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;

    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) exports.set('default', null);
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.exportClause) continue;
      if (ts.isNamespaceExport(statement.exportClause)) {
        exports.set(statement.exportClause.name.text, null);
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const exportedName = element.name.text;
        const localName = statement.moduleSpecifier
          ? null
          : (element.propertyName?.text ?? element.name.text);
        exports.set(exportedName, localName);
      }
      continue;
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) exports.set(name, name);
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)
    ) {
      const name = statement.name && ts.isIdentifier(statement.name) ? statement.name.text : null;
      if (isDefault) exports.set('default', name);
      else if (name) exports.set(name, name);
    }
  }

  return [...exports]
    .map(([exportedName, localName]) => ({ exportedName, localName }))
    .sort((left, right) => left.exportedName.localeCompare(right.exportedName));
}

function collectRuntimeReexports(sourceFile: ts.SourceFile): RuntimeReexport[] {
  const reexports: RuntimeReexport[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement)
      || statement.isTypeOnly
      || !statement.moduleSpecifier
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!statement.exportClause) {
      reexports.push({ specifier, kind: 'star' });
    } else if (ts.isNamespaceExport(statement.exportClause)) {
      reexports.push({ specifier, kind: 'namespace' });
    } else {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        reexports.push({
          specifier,
          kind: 'named',
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  }
  return reexports;
}

function runtimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allNamedTypeOnly =
        bindings
        && ts.isNamedImports(bindings)
        && bindings.elements.length > 0
        && bindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !(allNamedTypeOnly && !clause?.name)) {
        found.add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node)
      && !node.isTypeOnly
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found].sort();
}

function resolveSpecifier(
  fromPath: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = normalizePath(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [joined];
  if (/\.(?:mjs|cjs|js)$/i.test(joined)) {
    candidates.push(
      joined.replace(/\.(?:mjs|cjs|js)$/i, '.ts'),
      joined.replace(/\.(?:mjs|cjs|js)$/i, '.tsx'),
    );
  } else if (!/\.[a-z0-9]+$/i.test(joined)) {
    candidates.push(`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function parsedModules(sources: ModuleSource[]): Map<string, ParsedModule> {
  const modules = new Map<string, ParsedModule>();
  for (const source of sources) {
    const path = normalizePath(source.path);
    if (!/\.tsx?$/.test(path) || path.endsWith('.d.ts')) continue;
    if (modules.has(path)) throw new Error(`duplicate module source: ${path}`);
    const normalizedSource = { ...source, path };
    const sourceFile = parseSource(normalizedSource);
    modules.set(path, {
      path,
      sourceFile,
      directExports: collectDirectRuntimeExports(sourceFile),
      reexports: collectRuntimeReexports(sourceFile),
    });
  }
  return modules;
}

export function buildModuleGraph(sources: ModuleSource[]): ModuleGraph {
  const modules = parsedModules(sources);
  const files = sortedSet(modules.keys());
  const runtimeEdges = new Map<string, ReadonlySet<string>>();
  const unresolvedRuntimeSpecifiers = new Map<string, ReadonlySet<string>>();
  const runtimeExports = new Map<string, Set<string>>();

  for (const path of files) {
    const module = modules.get(path)!;
    const edges = new Set<string>();
    const unresolved = new Set<string>();
    for (const specifier of runtimeSpecifiers(module.sourceFile)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveSpecifier(path, specifier, files);
      if (resolved) edges.add(resolved);
      else unresolved.add(specifier);
    }
    runtimeEdges.set(path, sortedSet(edges));
    unresolvedRuntimeSpecifiers.set(path, sortedSet(unresolved));
    runtimeExports.set(path, new Set(module.directExports.map((item) => item.exportedName)));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const path of files) {
      const module = modules.get(path)!;
      const exports = runtimeExports.get(path)!;
      for (const reexport of module.reexports) {
        if (reexport.kind !== 'star') continue;
        const target = resolveSpecifier(path, reexport.specifier, files);
        if (!target) continue;
        for (const name of runtimeExports.get(target) ?? []) {
          if (name === 'default' || exports.has(name)) continue;
          exports.add(name);
          changed = true;
        }
      }
    }
  }

  return {
    files,
    runtimeEdges,
    unresolvedRuntimeSpecifiers,
    runtimeExports: new Map(
      [...runtimeExports].map(([path, names]) => [path, sortedSet(names)]),
    ),
  };
}

export function analyzeReachability(
  graph: ModuleGraph,
  roots: string[],
  candidates: string[],
): ReachabilityResult {
  const normalizedRoots = [...new Set(roots.map(normalizePath))].sort();
  const reachable = new Set<string>();
  const pending = normalizedRoots.filter((root) => graph.files.has(root)).reverse();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const targets = [...(graph.runtimeEdges.get(current) ?? [])].sort().reverse();
    for (const target of targets) {
      if (!reachable.has(target)) pending.push(target);
    }
  }

  const sortedReachable = sortedSet(reachable);
  const unresolved = [...sortedReachable]
    .flatMap((importer) =>
      [...(graph.unresolvedRuntimeSpecifiers.get(importer) ?? [])].map((specifier) => ({
        importer,
        specifier,
      })),
    )
    .sort((left, right) =>
      `${left.importer}\0${left.specifier}`.localeCompare(`${right.importer}\0${right.specifier}`),
    );

  return {
    roots: normalizedRoots,
    reachable: sortedReachable,
    unreachableCandidates: [...new Set(candidates.map(normalizePath))]
      .filter((path) => !sortedReachable.has(path))
      .sort(),
    unresolved,
  };
}

function isInsideSkippedSyntax(node: ts.Identifier): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isImportDeclaration(current)
      || ts.isImportEqualsDeclaration(current)
      || ts.isExportDeclaration(current)
      || ts.isInterfaceDeclaration(current)
      || ts.isTypeAliasDeclaration(current)
      || ts.isTypeNode(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent)
      || ts.isEnumDeclaration(parent)
      || ts.isModuleDeclaration(parent)
      || ts.isBindingElement(parent))
    && parent.name === node
  ) {
    return true;
  }
  if (
    (ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isPropertyAssignment(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isMethodSignature(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent))
    && parent.name === node
  ) {
    return true;
  }
  if (
    (ts.isLabeledStatement(parent)
      || ts.isBreakStatement(parent)
      || ts.isContinueStatement(parent))
    && parent.label === node
  ) {
    return true;
  }
  return ts.isPropertyAccessExpression(parent) && parent.name === node;
}

function isRuntimeIdentifierUse(node: ts.Identifier): boolean {
  return !isInsideSkippedSyntax(node) && !isDeclarationIdentifier(node);
}

function hasRuntimeIdentifierUse(sourceFile: ts.SourceFile, localName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === localName && isRuntimeIdentifierUse(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function collectImportBindings(
  module: ParsedModule,
  files: ReadonlySet<string>,
): { direct: DirectImportBinding[]; namespaces: NamespaceImportBinding[] } {
  const direct: DirectImportBinding[] = [];
  const namespaces: NamespaceImportBinding[] = [];

  for (const statement of module.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || statement.importClause?.isTypeOnly
      || !statement.importClause
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const targetPath = resolveSpecifier(module.path, statement.moduleSpecifier.text, files);
    if (!targetPath) continue;
    const clause = statement.importClause;
    if (clause.name) {
      direct.push({ localName: clause.name.text, importedName: 'default', targetPath });
    }
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.push({ localName: clause.namedBindings.name.text, targetPath });
    } else {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        direct.push({
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          targetPath,
        });
      }
    }
  }

  return { direct, namespaces };
}

function namespaceMemberUses(sourceFile: ts.SourceFile, localName: string): Set<string> {
  const members = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
      && !isInsideSkippedSyntax(node.expression)
    ) {
      members.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === localName
      && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression)
      && !isInsideSkippedSyntax(node.expression)
    ) {
      members.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
}

function hasDirectNamespaceUse(sourceFile: ts.SourceFile, localName: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === localName && isRuntimeIdentifierUse(node)) {
      const parent = node.parent;
      if (
        !(
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
          && parent.expression === node
        )
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function analyzeExportOwnership(
  sources: ModuleSource[],
  graph: ModuleGraph,
  reachable: ReadonlySet<string>,
): ExportOwnershipResult {
  const modules = parsedModules(sources);
  const ownersByExport = new Map<string, Set<string>>();
  const keyFor = (path: string, name: string) => `${path}\0${name}`;
  const addOwner = (path: string, name: string, owner: string): void => {
    if (!graph.runtimeExports.get(path)?.has(name)) return;
    const key = keyFor(path, name);
    const owners = ownersByExport.get(key) ?? new Set<string>();
    owners.add(owner);
    ownersByExport.set(key, owners);
  };

  for (const path of [...reachable].sort()) {
    const module = modules.get(path);
    if (!module) continue;

    for (const runtimeExport of module.directExports) {
      if (
        runtimeExport.localName
        && hasRuntimeIdentifierUse(module.sourceFile, runtimeExport.localName)
      ) {
        addOwner(path, runtimeExport.exportedName, path);
      }
    }

    const bindings = collectImportBindings(module, graph.files);
    for (const binding of bindings.direct) {
      if (hasRuntimeIdentifierUse(module.sourceFile, binding.localName)) {
        addOwner(binding.targetPath, binding.importedName, path);
      }
    }
    for (const binding of bindings.namespaces) {
      for (const member of namespaceMemberUses(module.sourceFile, binding.localName)) {
        addOwner(binding.targetPath, member, path);
      }
      if (hasDirectNamespaceUse(module.sourceFile, binding.localName)) {
        for (const name of graph.runtimeExports.get(binding.targetPath) ?? []) {
          addOwner(binding.targetPath, name, path);
        }
      }
    }

    for (const reexport of module.reexports) {
      const targetPath = resolveSpecifier(path, reexport.specifier, graph.files);
      if (!targetPath) continue;
      if (reexport.kind === 'named' && reexport.importedName) {
        addOwner(targetPath, reexport.importedName, path);
      } else {
        for (const name of graph.runtimeExports.get(targetPath) ?? []) {
          if (reexport.kind === 'star' && name === 'default') continue;
          addOwner(targetPath, name, path);
        }
      }
    }
  }

  const owned: ExportOwnershipResult['owned'] = [];
  const unowned: ExportOwnershipResult['unowned'] = [];
  for (const path of [...reachable].sort()) {
    for (const name of graph.runtimeExports.get(path) ?? []) {
      const owners = [...(ownersByExport.get(keyFor(path, name)) ?? [])].sort();
      if (owners.length > 0) owned.push({ path, name, owners });
      else unowned.push({ path, name });
    }
  }

  const compareExport = (left: { path: string; name: string }, right: { path: string; name: string }) =>
    `${left.path}\0${left.name}`.localeCompare(`${right.path}\0${right.name}`);
  owned.sort(compareExport);
  unowned.sort(compareExport);
  return { unowned, owned };
}
