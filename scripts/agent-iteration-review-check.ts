import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AgentReviewIssue {
  code: string;
  message: string;
}

export interface AgentReviewResult {
  ok: boolean;
  decision: AgentReviewDecision | null;
  issues: AgentReviewIssue[];
}

export type AgentReviewDecision = 'continue' | 'retry' | 'rollback' | 'escalate';

const REQUIRED_SECTIONS = [
  'Summary',
  'Intended Invariants',
  'Checks',
  'Failures',
  'Remaining Risks',
  'Decision',
] as const;

const DECISION_RE = /\b(?:decision\s*:\s*)?(continue|retry|rollback|escalate)\b/i;
const CHECK_SIGNAL_RE = /\b(?:pass|passed|fail|failed|skip|skipped|blocked)\b|-\s*\[[ x!-]\]/i;
const PLACEHOLDER_RE = /\b(?:todo|tbd|fixme|placeholder)\b/i;

export function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const headingRe = /^##\s+(.+?)\s*$/;
  const start = lines.findIndex((line) => headingRe.exec(line)?.[1] === heading);
  if (start < 0) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) break;
    body.push(lines[i]);
  }

  return body.join('\n').trim() || null;
}

export function validateAgentIterationReview(markdown: string): AgentReviewResult {
  const issues: AgentReviewIssue[] = [];

  for (const section of REQUIRED_SECTIONS) {
    const body = sectionBody(markdown, section);
    if (!body) {
      issues.push({
        code: 'missing-section',
        message: `Agent iteration review must include a non-empty "## ${section}" section.`,
      });
    }
  }

  if (PLACEHOLDER_RE.test(markdown)) {
    issues.push({
      code: 'placeholder',
      message: 'Agent iteration review contains placeholder language; replace it with concrete evidence or risk.',
    });
  }

  const checks = sectionBody(markdown, 'Checks');
  if (checks && !CHECK_SIGNAL_RE.test(checks)) {
    issues.push({
      code: 'checks-no-status',
      message: 'Checks section must state which checks passed, failed, skipped, or blocked the iteration.',
    });
  }

  const decisionBody = sectionBody(markdown, 'Decision');
  const decisionMatch = decisionBody?.match(DECISION_RE);
  const decision = (decisionMatch?.[1]?.toLowerCase() as AgentReviewDecision | undefined) ?? null;
  if (!decision) {
    issues.push({
      code: 'missing-decision',
      message: 'Decision section must choose one of: continue, retry, rollback, escalate.',
    });
  }

  return { ok: issues.length === 0, decision, issues };
}

interface ParsedArgs {
  artifactPath: string | null;
  help: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let artifactPath = env.WHATSOUP_AGENT_ITERATION_REVIEW?.trim() || null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--artifact') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--artifact requires a path');
      artifactPath = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { artifactPath, help };
}

function printHelp(): void {
  console.log(`Usage: npm run guard:agent-iteration-review -- --artifact <path>

Validates the self-review artifact required for unattended agentic iterations.
The artifact must include non-empty sections:
  ## Summary
  ## Intended Invariants
  ## Checks
  ## Failures
  ## Remaining Risks
  ## Decision

Decision must be one of: continue, retry, rollback, escalate.
`);
}

export function run(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): AgentReviewResult {
  const args = parseArgs(argv, env);
  if (args.help) {
    printHelp();
    return { ok: true, decision: null, issues: [] };
  }

  if (!args.artifactPath) {
    throw new Error('Missing agent iteration review artifact path. Pass --artifact <path> or set WHATSOUP_AGENT_ITERATION_REVIEW.');
  }

  const artifactPath = path.resolve(args.artifactPath);
  const result = validateAgentIterationReview(readFileSync(artifactPath, 'utf8'));
  if (!result.ok) {
    for (const issue of result.issues) {
      console.error(`${artifactPath} ${issue.code}: ${issue.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`agent iteration review passed (${result.decision})`);
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
