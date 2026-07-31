/**
 * CLI argument primitives, and the ratchet that stops hand-rolled parsers multiplying.
 *
 * The tests that matter here are the two silent-corruption cases `takeValue` exists to
 * refuse. Both were present in shipped code (`scripts/drift-classify.ts`) when this helper
 * was written, and neither produced any error at the time:
 *
 *   parseArgs(['--base'])          -> no `base` at all, flag silently dropped
 *   parseArgs(['--base','--json']) -> base === '--json', the next FLAG consumed as a value
 *
 * The second is the dangerous one: that string would have been handed to git as a ref.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  CliArgError,
  assertKnownFlag,
  isFlagToken,
  isHelpFlag,
  parseClosedOptions,
  takeNumber,
  takeValue,
} from '../../scripts/lib/cli-args.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('takeValue — refuses the two silent-corruption cases', () => {
  it('reads a normal value', () => {
    expect(takeValue(['--base', 'abc123'], 0)).toEqual({ value: 'abc123', index: 1 });
  });

  it('THROWS when the value is missing entirely', () => {
    // Was: silently undefined, flag dropped with no signal.
    expect(() => takeValue(['--base'], 0)).toThrow(/--base requires a value/);
    expect(() => takeValue(['--base'], 0)).toThrow(CliArgError);
  });

  it('THROWS when the next argument is another flag', () => {
    // Was: base === '--json', which would then be used as a git ref. This is the case
    // that actually corrupts rather than merely dropping.
    expect(() => takeValue(['--base', '--json'], 0)).toThrow(/another flag \(--json\)/);
  });

  it('accepts a bare "-" as a value — it is stdin, not a flag', () => {
    // `guard:branch-protection-drift` pipes with `--observed -`; treating that as a flag
    // would break a real existing call site.
    expect(takeValue(['--observed', '-'], 0).value).toBe('-');
  });

  it('accepts a negative-number-looking value only when it is not flag-shaped', () => {
    expect(isFlagToken('-5')).toBe(true); // conservative: reject, force explicit handling
    expect(isFlagToken('-')).toBe(false);
    expect(isFlagToken('abc')).toBe(false);
    expect(isFlagToken(undefined)).toBe(false);
  });

  it('names the flag in the error even when the caller overrides the label', () => {
    expect(() => takeValue(['-b'], 0, '--base')).toThrow(/--base requires a value/);
  });
});

describe('takeNumber', () => {
  it('parses a real number', () => {
    expect(takeNumber(['--port', '8080'], 0)).toEqual({ value: 8080, index: 1 });
  });

  it('THROWS on a non-numeric value rather than yielding NaN', () => {
    // Number('abc') is NaN and would flow onward as a plausible-looking bound.
    expect(() => takeNumber(['--port', 'abc'], 0)).toThrow(/requires a number/);
  });

  it('THROWS on an empty value rather than yielding 0', () => {
    // Number('') === 0 — a silently valid-looking port.
    expect(() => takeNumber(['--port', ''], 0)).toThrow(/requires a number/);
  });

  it('inherits the missing-value and next-flag refusals', () => {
    expect(() => takeNumber(['--port'], 0)).toThrow(/requires a value/);
    expect(() => takeNumber(['--port', '--json'], 0)).toThrow(/another flag/);
  });
});

describe('assertKnownFlag', () => {
  it('accepts a known flag and ignores positionals', () => {
    expect(() => assertKnownFlag('--json', ['--json', '--help'])).not.toThrow();
    expect(() => assertKnownFlag('some/path.ts', ['--json'])).not.toThrow();
  });

  it('THROWS on an unknown flag and lists what was accepted', () => {
    // A silently-ignored typo turns "--staged" into a full-tree scan reporting success.
    expect(() => assertKnownFlag('--stagd', ['--json', '--staged'])).toThrow(/Unknown argument: --stagd/);
    expect(() => assertKnownFlag('--stagd', ['--json', '--staged'])).toThrow(/--json, --staged/);
  });
});

describe('isHelpFlag', () => {
  it('matches both spellings this tree uses and nothing else', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag('--helpful')).toBe(false);
  });
});

describe('parseClosedOptions', () => {
  const schema = {
    booleanOptions: ['--json'] as const,
    valueOptions: ['--base', '--candidate'] as const,
  };

  it('parses only the declared boolean and value options', () => {
    const parsed = parseClosedOptions(
      ['--base', 'a'.repeat(40), '--json', '--candidate', 'b'.repeat(40)],
      schema,
    );
    expect(parsed.error).toBeNull();
    expect([...parsed.flags]).toEqual(['--json']);
    expect([...parsed.values]).toEqual([
      ['--base', 'a'.repeat(40)],
      ['--candidate', 'b'.repeat(40)],
    ]);
  });

  it.each([
    [['--unknown'], 'ci.input.option-unknown'],
    [['--json', '--json'], 'ci.input.duplicate-option'],
    [['--base', 'one', '--base', 'two'], 'ci.input.duplicate-option'],
    [['--base'], 'ci.input.option-value-missing'],
    [['--base', '--json'], 'ci.input.option-value-missing'],
  ] as const)('fails closed for %j', (args, code) => {
    expect(parseClosedOptions(args, schema).error).toBe(code);
  });
});

/**
 * Warn-level ratchet on hand-rolled parsers.
 *
 * 33 scripts define their own `parseArgs` or `parseCommand`; 29 still hand-roll value
 * parsing. Rewriting all of them is a large, high-blast-radius change across many lanes,
 * so this does NOT demand that. It pins the hand-rolled count so it cannot grow: existing
 * debt is tolerated, new debt is blocked — the same shape as the `arch.ssot-*` ratchets.
 *
 * Lowering the baseline as scripts migrate is expected and the assertion says so.
 */
describe('hand-rolled parseArgs ratchet', () => {
  const HAND_ROLLED_PARSEARGS_BASELINE = 30;

  const isHandRolledParser = (source: string): boolean => {
    const sourceFile = ts.createSourceFile(
      'candidate.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
    };
    const host = ts.createCompilerHost(options, true);
    host.fileExists = (fileName) => fileName === sourceFile.fileName;
    host.getSourceFile = (fileName) => fileName === sourceFile.fileName ? sourceFile : undefined;
    host.readFile = (fileName) => fileName === sourceFile.fileName ? source : undefined;
    host.writeFile = () => {};
    const checker = ts.createProgram({
      rootNames: [sourceFile.fileName],
      options,
      host,
    }).getTypeChecker();
    const sharedBindings = new Set<ts.Symbol>();

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || !/(?:^|\/)cli-args\.ts$/.test(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        // parseClosedOptions counts too: it is built on takeValue and additionally
        // rejects duplicate and unknown options, so a parser using it is strictly
        // safer than one calling takeValue directly. Recognising only takeValue
        // reported such a parser as hand-rolled and pushed authors down to the
        // weaker primitive to satisfy the ratchet.
        if (['takeValue', 'parseClosedOptions'].includes((element.propertyName ?? element.name).text)) {
          const symbol = checker.getSymbolAtLocation(element.name);
          if (symbol) sharedBindings.add(symbol);
        }
      }
    }

    const functions = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
    const parsers: ts.FunctionLikeDeclaration[] = [];
    const collectFunctions = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) functions.set(symbol, node);
        if (node.name.text === 'parseArgs' || node.name.text === 'parseCommand') {
          parsers.push(node);
        }
      }
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) functions.set(symbol, node.initializer);
        if (node.name.text === 'parseArgs' || node.name.text === 'parseCommand') {
          parsers.push(node.initializer);
        }
      }
      ts.forEachChild(node, collectFunctions);
    };
    collectFunctions(sourceFile);

    const callsSharedBinding = (
      declaration: ts.FunctionLikeDeclaration,
      visited = new Set<ts.FunctionLikeDeclaration>(),
    ): boolean => {
      if (visited.has(declaration)) return false;
      visited.add(declaration);
      let found = false;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const calledSymbol = checker.getSymbolAtLocation(node.expression);
          if (calledSymbol && sharedBindings.has(calledSymbol)) {
            found = true;
            return;
          }
          const calledFunction = calledSymbol ? functions.get(calledSymbol) : undefined;
          if (calledFunction && callsSharedBinding(calledFunction, visited)) {
            found = true;
            return;
          }
        }
        if (!found) ts.forEachChild(node, visit);
      };
      if (declaration.body) visit(declaration.body);
      return found;
    };

    return parsers.length > 0 && parsers.some((parser) => !callsSharedBinding(parser));
  };

  const scriptsDefiningHandRolledParsers = (): string[] =>
    execFileSync('git', ['ls-files', '--', 'scripts/*.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      .filter((path) => isHandRolledParser(readFileSync(resolve(repoRoot, path), 'utf8')));

  it('the scan is not vacuous — it really finds hand-rolled parsers', () => {
    // Without this, a git-grep that returned nothing would make the ratchet pass trivially.
    expect(scriptsDefiningHandRolledParsers().length).toBeGreaterThan(10);
  });

  it('the number of hand-rolled parsers does not grow', () => {
    const found = scriptsDefiningHandRolledParsers();
    expect(
      found.length,
      found.length > HAND_ROLLED_PARSEARGS_BASELINE
        ? `${found.length - HAND_ROLLED_PARSEARGS_BASELINE} new hand-rolled parseArgs since the baseline. ` +
          `Use the primitives in scripts/lib/cli-args.ts instead — takeValue() refuses the ` +
          `missing-value and next-flag-as-value cases that hand-rolled 'argv[++i]' accepts silently.`
        : `Baseline is stale: ${found.length} found, baseline ${HAND_ROLLED_PARSEARGS_BASELINE}. ` +
          `Scripts migrated — LOWER HAND_ROLLED_PARSEARGS_BASELINE to ${found.length} to lock in the gain.`,
    ).toBe(HAND_ROLLED_PARSEARGS_BASELINE);
  });

  it('does not let a renamed parser evade the shared-primitive requirement', () => {
    expect(isHandRolledParser('export function parseCommand(argv: string[]) { return argv[1]; }'))
      .toBe(true);
    expect(isHandRolledParser(
      'export const parseArgs = (argv: string[]) => argv[1];',
    )).toBe(true);
    expect(isHandRolledParser(
      'export const parseCommand = function (argv: string[]) { return argv[1]; };',
    )).toBe(true);
    expect(isHandRolledParser(
      "import { takeValue } from './lib/cli-args.ts';\n" +
      'export function parseCommand(argv: string[]) { return takeValue(argv, 0).value; }',
    )).toBe(false);
  });

  it('requires the imported primitive to be called inside the detected parser', () => {
    const imported = "import { takeValue } from './lib/cli-args.ts';\n";

    expect(isHandRolledParser(
      imported +
      '// takeValue(argv, 0)\n' +
      'export function parseArgs(argv: string[]) { return argv[1]; }',
    )).toBe(true);
    expect(isHandRolledParser(
      imported +
      'const example = "takeValue(argv, 0)";\n' +
      'export function parseArgs(argv: string[]) { return argv[1]; }',
    )).toBe(true);
    expect(isHandRolledParser(
      imported +
      'function helper(argv: string[]) { return takeValue(argv, 0).value; }\n' +
      'export function parseArgs(argv: string[]) { return argv[1]; }',
    )).toBe(true);
    expect(isHandRolledParser(
      imported +
      'function helper(argv: string[]) { return takeValue(argv, 0).value; }\n' +
      'export function parseArgs(argv: string[]) { return helper(argv); }',
    )).toBe(false);
    expect(isHandRolledParser(
      imported +
      'export function parseArgs(takeValue: Function, argv: string[]) {' +
      ' return takeValue(argv, 0); }',
    )).toBe(true);
    expect(isHandRolledParser(
      imported +
      'export function parseArgs(argv: string[]) {' +
      ' const takeValue = (args: string[]) => args[1]; return takeValue(argv); }',
    )).toBe(true);
    expect(isHandRolledParser(
      imported +
      'export function parseArgs(argv: string[]) {' +
      ' function helper(args: string[]) { return args[1]; } return helper(argv); }\n' +
      'function unrelated() {' +
      ' function helper(args: string[]) { return takeValue(args, 0).value; } return helper; }',
    )).toBe(true);
  });
});
