import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readCandidateTree,
  type CandidateTree,
  type SemanticScope,
} from './lib/semantic-quality/git-tree.ts';
import {
  evaluateSemanticPolicy,
  loadSemanticPolicy,
  type SemanticPolicyFinding,
} from './lib/semantic-quality/policy.ts';
import {
  buildBoundaryReceipt,
  buildSemanticReceipt,
  renderSemanticReceipt,
  semanticExitCode,
  writeLocalReceipt,
  writeSemanticReceipt,
  type BoundaryReceipt,
  type EnforcementMode,
} from './lib/semantic-quality/receipt.ts';

type OutputFormat = 'human' | 'json';

export interface SemanticQualityCliOptions {
  scope: SemanticScope;
  head: string;
  base: string;
  targetRef: string | null;
  mode: EnforcementMode;
  format: OutputFormat;
  receiptPath: string | null;
  noReceipt: boolean;
}

export interface SemanticQualityRunResult {
  receipt: BoundaryReceipt;
  receiptPath: string | null;
}

const SINGLETON_FLAGS = new Set([
  '--scope', '--head', '--base', '--target-ref', '--mode', '--format', '--receipt', '--no-receipt',
]);

function markSingleton(seen: Set<string>, flag: string): void {
  if (!SINGLETON_FLAGS.has(flag)) return;
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  seen.add(flag);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function choice<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function parseSemanticQualityArgs(argv: string[]): SemanticQualityCliOptions {
  const options: SemanticQualityCliOptions = {
    scope: 'branch',
    head: 'HEAD',
    base: 'origin/main',
    targetRef: null,
    mode: 'shadow',
    format: 'human',
    receiptPath: null,
    noReceipt: false,
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    markSingleton(seen, arg);
    if (arg === '--scope') {
      options.scope = choice(arg, requiredValue(argv, index, arg), ['branch', 'tree']);
      index += 1;
    } else if (arg === '--head') {
      options.head = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--base') {
      options.base = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--target-ref') {
      options.targetRef = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--mode') {
      options.mode = choice(arg, requiredValue(argv, index, arg), ['shadow', 'enforce']);
      index += 1;
    } else if (arg === '--format') {
      options.format = choice(arg, requiredValue(argv, index, arg), ['human', 'json']);
      index += 1;
    } else if (arg === '--receipt') {
      options.receiptPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === '--no-receipt') {
      options.noReceipt = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.receiptPath && options.noReceipt) {
    throw new Error('--receipt and --no-receipt are mutually exclusive');
  }
  return options;
}

function rawValue(argv: string[], flag: string): string | undefined {
  const index = argv.lastIndexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fallbackDiagnosticOptions(argv: string[]): SemanticQualityCliOptions {
  const exactFormat = argv.filter((value) => value === '--format').length === 1
    ? rawValue(argv, '--format')
    : undefined;
  return {
    scope: 'branch',
    head: 'HEAD',
    base: 'origin/main',
    targetRef: null,
    mode: 'enforce',
    format: exactFormat === 'json' ? 'json' : 'human',
    receiptPath: null,
    noReceipt: true,
  };
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown semantic quality failure';
}

function emptyTree(limitation: string): CandidateTree {
  return {
    headOid: '',
    baseOid: null,
    mergeBaseOid: null,
    sources: [],
    changedPaths: [],
    limitations: [limitation],
  };
}

function inconclusiveFinding(
  ruleId:
    | 'semantic.candidate-unavailable'
    | 'semantic.policy-unavailable'
    | 'semantic.analysis-unavailable'
    | 'semantic.invocation-invalid'
    | 'semantic.receipt-write-failed',
  label:
    | 'candidate_problem'
    | 'policy_read_problem'
    | 'analysis_problem'
    | 'invocation_problem'
    | 'receipt_write_problem',
  message: string,
): SemanticPolicyFinding {
  return {
    ruleId,
    decision: 'inconclusive',
    paths: [],
    evidence: [{ label, value: message }],
  };
}

function invalidPolicyFinding(message: string): SemanticPolicyFinding {
  return {
    ruleId: 'semantic.invalid-allowlist',
    decision: 'block',
    paths: [],
    evidence: [{ label: 'policy_problem', value: message }],
  };
}

function evaluateInvocation(
  options: SemanticQualityCliOptions,
  cwd: string,
): { receipt: BoundaryReceipt; tree: CandidateTree } {
  let tree: CandidateTree;
  try {
    tree = readCandidateTree({
      cwd,
      head: options.head,
      baseRef: options.scope === 'branch' ? options.base : undefined,
      scope: options.scope,
    });
  } catch (error) {
    const message = boundedMessage(error);
    tree = emptyTree(message);
    return {
      tree,
      receipt: buildSemanticReceipt({
        tree,
        policyFindings: [
          inconclusiveFinding(
            'semantic.candidate-unavailable',
            'candidate_problem',
            message,
          ),
        ],
        enforcementMode: options.mode,
        evidenceSource: `git:${options.head}`,
      }),
    };
  }
  let policyFindings: SemanticPolicyFinding[];

  if (!tree.headOid) {
    policyFindings = [
      inconclusiveFinding(
        'semantic.candidate-unavailable',
        'candidate_problem',
        tree.limitations.join('; ') || `candidate ${options.head} could not be resolved`,
      ),
    ];
  } else {
    try {
      const policy = loadSemanticPolicy(cwd, tree.headOid);
      policyFindings = evaluateSemanticPolicy({ tree, policy, now: new Date() });
    } catch (error) {
      const message = boundedMessage(error);
      policyFindings = [
        message.includes('invalid semantic quality policy')
          ? invalidPolicyFinding(message)
          : inconclusiveFinding(
              'semantic.policy-unavailable',
              'policy_read_problem',
              message,
            ),
      ];
    }
  }

  return {
    tree,
    receipt: buildSemanticReceipt({
      tree,
      policyFindings,
      enforcementMode: options.mode,
      evidenceSource: `git:${tree.headOid || options.head}`,
    }),
  };
}

function addReceiptWriteFailure(
  receipt: BoundaryReceipt,
  tree: CandidateTree,
  message: string,
): BoundaryReceipt {
  const failedWrite = buildSemanticReceipt({
    tree,
    policyFindings: [
      inconclusiveFinding(
        'semantic.receipt-write-failed',
        'receipt_write_problem',
        message,
      ),
    ],
    enforcementMode: receipt.enforcementMode,
    evidenceSource: receipt.base.evidenceSource,
    limitations: [message],
  });
  return buildBoundaryReceipt({
    invocation: receipt.invocation,
    action: receipt.action ?? 'push',
    enforcementMode: receipt.enforcementMode,
    base: receipt.base,
    fingerprints: receipt.fingerprints,
    findings: [...receipt.findings, ...failedWrite.findings],
    limitations: [...new Set([...receipt.limitations, message])],
  });
}

function writeReceiptForInvocation(
  cwd: string,
  options: SemanticQualityCliOptions,
  receipt: BoundaryReceipt,
): string | null {
  if (process.env.CI && !options.receiptPath) {
    throw new Error('CI requires an explicit --receipt path');
  }
  if (options.noReceipt) return null;
  if (options.receiptPath) {
    const target = path.isAbsolute(options.receiptPath)
      ? options.receiptPath
      : path.resolve(cwd, options.receiptPath);
    return writeSemanticReceipt(target, receipt);
  }
  return writeLocalReceipt(cwd, receipt);
}

function emit(receipt: BoundaryReceipt, receiptPath: string | null, format: OutputFormat): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  if (receipt.decision === 'pass') {
    const base = renderSemanticReceipt(receipt).trimEnd();
    process.stdout.write(`${base} receipt=${receiptPath ?? 'disabled'}\n`);
    return;
  }
  process.stderr.write(renderSemanticReceipt(receipt));
  process.stderr.write(`Receipt: ${receiptPath ?? 'disabled'}\n`);
}

export function runSemanticQuality(
  argv: string[] = process.argv.slice(2),
  cwd = process.cwd(),
): SemanticQualityRunResult {
  let options: SemanticQualityCliOptions;
  let tree!: CandidateTree;
  let receipt: BoundaryReceipt | null = null;

  try {
    options = parseSemanticQualityArgs(argv);
  } catch (error) {
    options = fallbackDiagnosticOptions(argv);
    const message = boundedMessage(error);
    tree = emptyTree(message);
    receipt = buildSemanticReceipt({
      tree,
      policyFindings: [
        inconclusiveFinding(
          'semantic.invocation-invalid',
          'invocation_problem',
          message,
        ),
      ],
      enforcementMode: options.mode,
      evidenceSource: 'semantic-quality-cli',
    });
  }

  if (receipt === null) {
    try {
    const evaluated = evaluateInvocation(options, cwd);
    ({ tree, receipt } = evaluated);
    } catch (error) {
      const message = boundedMessage(error);
      tree = emptyTree(message);
      receipt = buildSemanticReceipt({
        tree,
        policyFindings: [
          inconclusiveFinding(
            'semantic.analysis-unavailable',
            'analysis_problem',
            message,
          ),
        ],
        enforcementMode: options.mode,
        evidenceSource: `git:${options.head}`,
      });
    }
  }

  let receiptPath: string | null = null;
  try {
    receiptPath = writeReceiptForInvocation(cwd, options, receipt);
  } catch (error) {
    const message = `receipt write failed: ${boundedMessage(error)}`;
    receipt = addReceiptWriteFailure(receipt, tree, message);
  }

  emit(receipt, receiptPath, options.format);
  process.exitCode = semanticExitCode(receipt);
  return { receipt, receiptPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSemanticQuality();
}
