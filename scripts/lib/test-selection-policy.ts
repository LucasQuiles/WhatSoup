import { EXPLICIT_REQUIRED_RUNTIME_PATHS } from '../check-bot-errors-runtime-manifest.ts';

export interface TestSelectionPolicy {
  profile: 'docs' | 'affected' | 'full';
  changedFiles: string[];
  reasons: string[];
  lanes: {
    root: boolean;
    console: boolean;
    browser: boolean;
    python: boolean;
    guard: boolean;
    docker: boolean;
    compatibility: boolean;
  };
}

type TestLanes = TestSelectionPolicy['lanes'];

function fullLanes(): TestLanes {
  return {
    root: true,
    console: true,
    browser: true,
    python: true,
    guard: true,
    docker: true,
    compatibility: true,
  };
}

function noLanes(): TestLanes {
  return {
    root: false,
    console: false,
    browser: false,
    python: false,
    guard: false,
    docker: false,
    compatibility: false,
  };
}

function fullPolicy(changedFiles: string[], reason: string): TestSelectionPolicy {
  return { profile: 'full', changedFiles, reasons: [reason], lanes: fullLanes() };
}

/** Reject path-like CLI inputs that cannot safely identify a repository file. */
export function isSafeChangedPath(candidate: string): boolean {
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    candidate.startsWith('-') ||
    candidate.startsWith('/') ||
    candidate.startsWith('\\') ||
    /^[a-z]:[\\/]/i.test(candidate) ||
    /[\0\r\n\\]/.test(candidate)
  ) {
    return false;
  }

  return candidate.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isInstructionPath(changedPath: string): boolean {
  return /(?:^|\/)(?:AGENTS|CLAUDE)(?:\.md)?$/i.test(changedPath);
}

function isRiskSensitiveName(changedPath: string): boolean {
  return /auth|identity|durability|migration|security|credential|secret|keyring|hmac|crypto|redact|sanitize|ssrf|capability|grant|scope|permission|private-fs|journal|process-lock|sqlite|transaction|recovery/i.test(
    changedPath,
  );
}

function isHighRiskPath(changedPath: string): boolean {
  const lower = changedPath.toLowerCase();
  if (
    lower.startsWith('.github/workflows/') ||
    lower.startsWith('scripts/') ||
    lower.startsWith('deploy/') ||
    lower.startsWith('tests/') ||
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|deno\.lock|\.npmrc|\.nvmrc)$/.test(lower) ||
    /^src\/(?:core|runtimes|transport|mcp|fleet)\//.test(lower) ||
    /(?:^|[\/._-])(?:workflow|config|configuration|schema|dependenc(?:y|ies)?|test|tests|testing)(?:[\/._-]|$)/.test(lower)
  ) {
    return true;
  }
  return isInstructionPath(changedPath) || isRiskSensitiveName(changedPath);
}

function isFixturePath(changedPath: string): boolean {
  return /(?:^|\/)(?:fixtures?|__fixtures__|testdata)(?:\/|$)/i.test(changedPath);
}

function isOperationalDocumentation(changedPath: string): boolean {
  return /(?:^|[\/._-])(?:runbooks?|operations?|operational|policies|policy|schemas?|configuration|config|enforcement|guardrails)(?:[\/._-]|$)/i.test(changedPath);
}

function isDocsOnlyPath(changedPath: string): boolean {
  if (changedPath === 'README.md' || changedPath === 'CONTRIBUTING.md') return true;
  return changedPath.startsWith('docs/') && changedPath.endsWith('.md') && !isOperationalDocumentation(changedPath);
}

function isSourceFile(changedPath: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(changedPath);
}

/**
 * Classify a validated changed-path set before application dependencies are installed.
 * It is intentionally conservative: anything outside the small, explicit affected set
 * selects the full matrix rather than offering a false green result.
 */
export function classifyTestChanges(
  paths: readonly string[],
  deploymentPaths: readonly string[] = EXPLICIT_REQUIRED_RUNTIME_PATHS,
): TestSelectionPolicy {
  const changedFiles = [...paths];
  if (changedFiles.length === 0) {
    return fullPolicy(changedFiles, 'no changed paths were provided');
  }

  const unsafePath = changedFiles.find((changedPath) => !isSafeChangedPath(changedPath));
  if (unsafePath !== undefined) {
    return fullPolicy(changedFiles, 'unsafe or malformed changed path');
  }

  const deployedPath = changedFiles.find((changedPath) => deploymentPaths.includes(changedPath));
  if (deployedPath !== undefined) {
    return fullPolicy(changedFiles, `deployment runtime change: ${deployedPath}`);
  }

  const highRiskPath = changedFiles.find(isHighRiskPath);
  if (highRiskPath !== undefined) {
    return fullPolicy(changedFiles, `high-risk change: ${highRiskPath}`);
  }

  const fixturePath = changedFiles.find(isFixturePath);
  if (fixturePath !== undefined) {
    return fullPolicy(changedFiles, `fixture or non-code input: ${fixturePath}`);
  }

  if (changedFiles.every(isDocsOnlyPath)) {
    return {
      profile: 'docs',
      changedFiles,
      reasons: ['documentation-only change; no application lane selected; static validation remains required'],
      lanes: noLanes(),
    };
  }

  const lanes = noLanes();
  const reasons: string[] = [];
  for (const changedPath of changedFiles) {
    if (isDocsOnlyPath(changedPath)) continue;
    if (changedPath.startsWith('console/src/') && isSourceFile(changedPath)) {
      lanes.root = true;
      lanes.console = true;
      lanes.browser = true;
      lanes.compatibility = true;
      if (!reasons.includes('console source change')) reasons.push('console source change');
      continue;
    }
    if (
      (changedPath.startsWith('src/lib/') || changedPath.startsWith('src/memory/')) &&
      isSourceFile(changedPath)
    ) {
      lanes.root = true;
      lanes.compatibility = true;
      if (!reasons.includes('library or memory source change')) {
        reasons.push('library or memory source change');
      }
      continue;
    }
    if (changedPath.startsWith('tools/whatsoup_guard/') && isSourceFile(changedPath)) {
      lanes.guard = true;
      if (!reasons.includes('Whatsoup guard tool change')) reasons.push('Whatsoup guard tool change');
      continue;
    }
    return fullPolicy(changedFiles, `unclassified change: ${changedPath}`);
  }

  return { profile: 'affected', changedFiles, reasons, lanes };
}
