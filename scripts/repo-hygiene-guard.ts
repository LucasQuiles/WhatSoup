import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  git,
  isOperationalProtocolToken,
  normalizeRepoPath,
  operationalReleaseHygieneFiles,
} from './lib/guard-core.ts';

export { normalizeRepoPath } from './lib/guard-core.ts';

export type GuardMode =
  | 'staged'
  | 'branch-diff'
  | 'commit-msg'
  | 'release-hygiene'
  | 'commit-authors'
  | 'scan-history';

export interface ParsedArgs {
  mode: GuardMode;
  messageFile?: string;
  baseRef?: string;
  historyDepth?: number;
  help: boolean;
}

export interface AddedLine {
  filePath: string;
  line: number;
  text: string;
}

export interface GuardIssue {
  code: string;
  message: string;
  filePath?: string;
  line?: number;
}

export interface CommitAuthor {
  sha: string;
  name: string;
  email: string;
  subject: string;
  message?: string;
}

interface GuardPattern {
  code: string;
  message: string;
  regex: RegExp;
}

const fixtureFiles = new Set([
  'scripts/anonymize-private-literals.ts',
  'scripts/repo-hygiene-guard.ts',
  // guard-core hosts the shared operational allowlist (real fleet file
  // paths + instance identifiers) consumed by both hygiene guards.
  'scripts/lib/guard-core.ts',
  'tests/scripts/anonymize-private-literals.test.ts',
  'tests/scripts/repo-hygiene-guard.test.ts',
  'tests/scripts/publication-guard.test.ts',
  'tests/eslint-rules/categorized-skips.test.ts',
  // BEAD-052 redaction-parity corpus: intentionally secret-, email-, and
  // path-SHAPED inputs that exercise the bot-errors redactor on both the TS and
  // Python sides. Real credential leaks remain covered by the separate global
  // pre-commit git-secret-scanner.
  'tests/fixtures/redaction-parity-corpus.jsonl',
]);

// The CAPE agent-runtime probe suite (tools/agent-runtime-probes/) is security/masking tooling:
// its corpus is intentionally secret-, email-, and path-SHAPED test fixtures. Treat the whole
// subtree as fixtures for these hygiene SHAPE patterns. Real credential leaks remain covered by the
// separate global pre-commit git-secret-scanner and the suite's own corpus_guard/sensitive_pattern_loader.
const isFixtureFile = (filePath: string): boolean =>
  fixtureFiles.has(filePath) || filePath.startsWith('tools/agent-runtime-probes/');

const releaseHygieneFiles = [
  'scripts/cutover.sh',
  'scripts/migrate-namespace.sh',
  'scripts/soak-check.sh',
  'src/runtimes/agent/providers/child-env.ts',
  'src/transport/contract/capabilities.ts',
];

const allowedEnvVarNameToken = /^[A-Z][A-Z0-9_]+_(?:MUTATIONS|TOKEN|KEY|URL|PATH)$/;
const allowedMessagingAddressRhs = /@(?:s\.whatsapp\.net|c\.us|lid)$/i;

// SSOT for the fleet private-host labels: the publication detection rule below,
// and consumers like the bot-errors collector-unit hygiene test, import this.
export const privateHostLabels = [
  ['mw', 'lab'],
  ['nuc', 'les'],
  ['ana', 'bot'],
  ['mac', 'lab'],
].map((parts) => parts.join(''));
const privateTailnetIps = [
  ['100', '91', '13', '7'],
  ['100', '84', '79', '77'],
].map((parts) => parts.join('.'));

const trackedSensitiveAllowlist = new Set(['.env.example', '.claude/settings.json']);

// Reserved/fictional phone ranges that are safe as test fixtures and documentation:
//   - North American 555-line numbers (NANP reserved-for-fiction, e.g. +1 415 555 0100)
//   - Repo synthetic fixtures: 1555*, 1111111*, 1000000000* (console/test fixtures)
//   - Obvious placeholders: +1234567890, +0...
//   - UK Ofcom drama range +447700 9xxxxx
//   - 15551230008 / 15551230006: repo-wide canonical synthetic test fixtures
//     (used as conversationKey/JID fixtures across tests/core/*; not a real line).
const allowedPhoneFixture = /^\+(?:1?(?:\d{3})?555\d{4}|1555\d+|1111111\d*|1?0{6,}\d*|1234567890|0+|44770[09]\d{6}|99990{0,4}\d+|1415555\d+|1999900\d+|1?5551230008|1?5551230006)$/;
// Twilio Account SID fixtures: all-zero / repeated-char placeholder bodies.
const allowedTwilioSidFixture = /^AC(?:0{32}|x{32}|X{32}|(?:0123456789abcdef){2})$/;
// Provider-key fixtures: explicit test/mock/fake/example markers within the token.
// Markers are delimiter-anchored so a real key body that merely CONTAINS the
// substring "sample"/"dummy" (e.g. base64 ...Sample...) is not allowlisted.
const allowedProviderKeyFixture = /(?:[_-]test[_-]|^sk-test|^pcsk_test|[_-](?:mock|fake|fixture|example|placeholder|redacted|dummy|sample)(?:[_-]|$))/i;
// Obvious non-secret values for the high-entropy secret-assignment pattern:
// redaction markers, placeholders, and low-entropy/repeated fixtures. Provider
// prefixed keys (sk-ant-, pcsk_, ghp_, AC...) are caught by their dedicated
// value-shape patterns, so secret-assignment only needs the keyword-bound
// high-entropy residual class.
const allowedSecretAssignmentValue = /(?:redacted|placeholder|example|changeme|your[_-]|dummy|fake|sample|notarealkey|should-be-overridden|0{8,}|(?:0123456789){2}|abcdefabcdef)/i;

const disallowedCommitAuthorPatterns: GuardPattern[] = [
  {
    code: 'placeholder-commit-author',
    message: 'Commit author uses a placeholder identity; amend before publishing.',
    regex: /\b(?:whatsoup-test|test|example)\.invalid\b/i,
  },
  {
    code: 'placeholder-commit-author',
    message: 'Commit author uses a placeholder identity; amend before publishing.',
    regex: /\bWhatSoup Test\b/i,
  },
  // Ad-hoc automation identities. The commit-time allowlist in
  // .husky/check-commit-identity.sh prevents these at creation; this denylist is
  // defense-in-depth so a --no-verify bypass is still caught by the CI range
  // scan. Sanctioned automation commits as SoupBot <soupbot@users.noreply.github.com>.
  {
    code: 'ad-hoc-bot-author',
    message:
      'Commit author uses a retired/ad-hoc automation identity; use SoupBot <soupbot@users.noreply.github.com>.',
    regex: /\bwhatsoup-bot\b|\bbot@users\.noreply\.github\.com\b/i,
  },
  {
    code: 'ad-hoc-bot-author',
    message:
      'Commit author uses a retired/ad-hoc automation identity; use SoupBot <soupbot@users.noreply.github.com>.',
    regex: /@(?:local|codex\.local)\b/i,
  },
];

function isAllowedPatternMatch(filePath: string, code: string, token: string): boolean {
  if (allowedEnvVarNameToken.test(token)) return true;
  if (code === 'personal-email' && allowedMessagingAddressRhs.test(token)) return true;
  if (code === 'operator-phone') {
    return allowedPhoneFixture.test(token.replace(/[\s().-]/g, ''));
  }
  if (code === 'twilio-account-sid') {
    return allowedTwilioSidFixture.test(token);
  }
  if (code === 'openai-key' || code === 'anthropic-key' || code === 'pinecone-key') {
    return allowedProviderKeyFixture.test(token);
  }
  if (code === 'secret-assignment') {
    return allowedSecretAssignmentValue.test(token);
  }
  // Operational health-profile / fleet-manifest files legitimately reference
  // real systemd template-unit names, which the email-shape regex matches.
  // The shared guard-core helper tolerates the trailing ".service" suffix.
  if (operationalReleaseHygieneFiles.has(filePath) && isOperationalProtocolToken(token)) {
    return true;
  }
  return false;
}

const srcConsoleAllowedFiles = new Set([
  'src/bootstrap.ts',
  'src/bootstrap-auth.ts',
  'src/config.ts',
  'src/fleet/standalone.ts',
  'src/transport/auth.ts',
]);

const addedLinePatterns: GuardPattern[] = [
  {
    code: 'merge-conflict-marker',
    message: 'Line looks like an unresolved merge conflict marker.',
    regex: /^\s*(?:<{7}|>{7}|={7})/,
  },
  {
    code: 'focused-test',
    message: 'Focused tests must not be committed.',
    regex: /\b(?:describe|it|test)\.only(?:\s*\(|\.)/,
  },
  {
    code: 'skipped-test',
    message: 'Skipped tests must not be committed without an explicit tracked exception.',
    regex: /\b(?:describe|it|test)\.skip(?:\s*\(|\.)/,
  },
  {
    code: 'debugger-statement',
    message: 'debugger statements must not be committed.',
    regex: /\bdebugger\b/,
  },
  {
    code: 'model-attribution',
    message: 'Public repo text must not include model or generated-by attribution.',
    regex: /\b(?:Claude\s+(?:Code|Opus|Sonnet|Haiku)|Generated\s+(?:with|by)\s+(?:Claude|Codex|GPT)|Authored\s+(?:with|by)\s+(?:Claude|Codex|GPT)|Written\s+(?:with|by)\s+(?:Claude|Codex|GPT)|noreply@anthropic\.com)\b/i,
  },
  {
    code: 'internal-workstream-label',
    message: 'Public repo text must not include internal planning labels.',
    regex: /\b(?:Phase\s+\d|WS-\d|B-\d|P1-[A-Z]|FF-\d{3}|TW-|typed-walrus|planprompt)\b/i,
  },
  {
    code: 'personal-email',
    message: 'Public repo text must not include personal email addresses.',
    regex: /\b[A-Z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|github\.com|s\.whatsapp\.net|g\.us)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    code: 'local-home-path',
    message: 'Public repo text must not include operator-local home paths.',
    regex: /\/(?:Users|home)\/(?!runner(?:\/|$)|testuser(?:\/|$)|whatsoup(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/,
  },
  {
    code: 'private-instance-label',
    message: 'Public repo text must not include private instance labels.',
    regex: /\b(?:BES Bot|Loops-managed|mw-bot|whatsapp:mw-bot|whatsapp-bot@(?:personal|loops|besbot)|whatsoup@(?:q|loops|besbot|personal)|whatsoup-personal|Q's (?:number|WhatsApp number))\b|instances\/personal\/(?:whatsoup\.sock|bot\.db)|\/home\/q\//,
  },
  {
    code: 'private-host-label',
    message: 'Public repo text must not include private host labels.',
    regex: new RegExp(`\\b(?:${privateHostLabels.join('|')})\\b`, 'i'),
  },
  {
    code: 'private-tailnet-ip',
    message: 'Public repo text must not include private tailnet IPs.',
    regex: new RegExp(`\\b(?:${privateTailnetIps.map((ip) => ip.replaceAll('.', '\\.')).join('|')})\\b`),
  },
  {
    code: 'whatsapp-group-jid',
    message: 'Public repo text must not include real-shaped WhatsApp group JIDs.',
    regex: /\b(?!12036355555555[0-9]{4}@g\.us\b)120363\d{6,}@g\.us\b/,
  },
  {
    code: 'whatsapp-user-jid',
    message: 'Public repo text must not include real-shaped WhatsApp user JIDs.',
    regex: /\b(?!(?:1555\d{4,}|1111111\d+|81536414179\d+)@(s\.whatsapp\.net|lid)\b)\d{8,}@(s\.whatsapp\.net|lid)\b/,
  },
  {
    code: 'github-token',
    message: 'Public repo text must not include GitHub token shapes.',
    // Charset-boundary (not \b): catches GH=ghp_... and "token":"ghp_..." forms.
    // Covers classic prefixes (ghp_/gho_/ghu_/ghs_/ghr_) and fine-grained PATs
    // (github_pat_...).
    regex: /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_-])/,
  },
  {
    code: 'anthropic-key',
    message: 'Public repo text must not include Anthropic API key shapes.',
    // Covers sk-ant-api03-..., sk-ant-admin01-..., etc. Charset-boundary so
    // ANTHROPIC_API_KEY=sk-ant-... and {"apiKey":"sk-ant-..."} are caught.
    regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9-]{12,}(?![A-Za-z0-9_-])/,
  },
  {
    code: 'openai-key',
    message: 'Public repo text must not include OpenAI key shapes.',
    // Excludes sk-ant- (handled by the dedicated anthropic-key pattern) so each
    // key matches exactly one code.
    regex: /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/,
  },
  {
    code: 'pinecone-key',
    message: 'Public repo text must not include Pinecone key shapes.',
    regex: /(?<![A-Za-z0-9_-])pcsk_[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/,
  },
  {
    code: 'twilio-account-sid',
    message: 'Public repo text must not include Twilio Account SID shapes.',
    // AC + 32 hex (case-insensitive). Charset-boundary avoids matching words like ACCOUNT.
    regex: /(?<![A-Za-z0-9])AC[0-9a-fA-F]{32}(?![A-Za-z0-9])/,
  },
  {
    code: 'slack-token',
    message: 'Public repo text must not include Slack token shapes.',
    regex: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{12,}(?![A-Za-z0-9_-])/,
  },
  {
    code: 'private-key',
    message: 'Public repo text must not include private key material.',
    // Full-block match (header AND body/footer) so a single-line PEM literal is
    // caught in its entirety; header-only fallback for multi-line diffs where only
    // the BEGIN line is on an added line. See feedback-secret-scan-word-boundary.
    regex: /-{5}BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-{5}/,
  },
  {
    code: 'secret-assignment',
    message: 'Public repo text must not include secret-bearing assignments.',
    // Keyword-based assignment WITHOUT a leading \b. The historical false-negative
    // (feedback-secret-scan-word-boundary-false-negative) is that \b never fires
    // between two word chars, so ANTHROPIC_API_KEY=, PINECONE_API_KEY=, MY_SECRET=,
    // and JSON "apiKey":"..." were silently missed. We anchor on the END of the
    // keyword instead and require a QUOTED, HIGH-ENTROPY string literal (>=20
    // chars with a digit and mixed case) — the form a real hardcoded secret takes.
    // Bare-identifier RHS (apiKey: config.apiKey) is variable indirection, and
    // short lowercase dummy fixtures (apiKey: 'sk-ant-secret') stay below the
    // entropy floor. Provider-prefixed keys are independently caught by the
    // dedicated value-shape patterns. allowedSecretAssignmentValue filters the
    // residual placeholder/repeated-char cases (fail-closed default).
    // Value is captured in the `value` group so allowlist checks see only the RHS
    // (not the key NAME) — closes the EXAMPLE_API_KEY=<real> bypass. Two value
    // forms qualify as high-entropy: (a) >=20 chars with a digit AND a letter of
    // each case OR a special char, (b) a >=20-char all-lowercase/upper hex blob
    // (HMAC/webhook secrets that carry no case signal).
    regex: /(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Aa][Uu][Tt][Hh][_-]?[Tt][Oo][Kk][Ee][Nn]|(?<![A-Za-z])[Ss][Ee][Cc][Rr][Ee][Tt](?:[_-]?[Kk][Ee][Yy])?|(?<![A-Za-z])[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|(?<![A-Za-z])[Pp][Aa][Ss][Ss][Ww][Dd])["']?\s*[:=]\s*["']?(?<value>(?:(?=[A-Za-z0-9_\-./+!@#$%^&*]{20})[A-Za-z0-9_\-./+!@#$%^&*]*[A-Z][A-Za-z0-9_\-./+!@#$%^&*]*[0-9][A-Za-z0-9_\-./+!@#$%^&*]*|(?=[A-Za-z0-9_\-./+!@#$%^&*]{20})[A-Za-z0-9_\-./+!@#$%^&*]*[a-z][A-Za-z0-9_\-./+!@#$%^&*]*[0-9][A-Za-z0-9_\-./+!@#$%^&*]*|[0-9a-fA-F]{32,}))/,
  },
  {
    code: 'operator-phone',
    message: 'Public repo text must not include real-shaped operator phone numbers.',
    // E.164 with explicit +; fixture-reserved ranges are allowlisted in
    // isAllowedPatternMatch (555-line, +1234567890, 1555*, 1111111*, UK +447700).
    regex: /\+[1-9]\d{9,14}(?!\d)/,
  },
];

const commitMessagePatterns: GuardPattern[] = [
  {
    code: 'commit-coauthor-trailer',
    message: 'Public commits must not include Co-Authored-By trailers.',
    regex: /^Co-Authored-By:/i,
  },
  ...addedLinePatterns.filter((pattern) => pattern.code !== 'merge-conflict-marker'),
];

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { mode: 'staged', help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--staged') {
      args.mode = 'staged';
    } else if (arg === '--branch-diff') {
      args.mode = 'branch-diff';
    } else if (arg === '--base') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--base requires a git ref');
      }
      args.baseRef = next;
      i += 1;
    } else if (arg === '--release-hygiene') {
      args.mode = 'release-hygiene';
    } else if (arg === '--commit-authors') {
      args.mode = 'commit-authors';
    } else if (arg === '--scan-history') {
      args.mode = 'scan-history';
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        const depth = Number(next);
        if (!Number.isInteger(depth) || depth <= 0) {
          throw new Error(`--scan-history depth must be a positive integer: ${next}`);
        }
        args.historyDepth = depth;
        i += 1;
      }
    } else if (arg === '--commit-msg') {
      args.mode = 'commit-msg';
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.messageFile = next;
        i += 1;
      }
    } else if (args.mode === 'commit-msg' && !args.messageFile) {
      args.messageFile = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.baseRef && args.mode !== 'branch-diff') {
    throw new Error('--base is only valid with --branch-diff');
  }

  return args;
}

function stripDiffPath(filePath: string): string {
  if (filePath.startsWith('b/')) return normalizeRepoPath(filePath.slice(2));
  return normalizeRepoPath(filePath);
}

export function parseUnifiedDiffAddedLines(diff: string): AddedLine[] {
  const addedLines: AddedLine[] = [];
  let filePath: string | null = null;
  let nextLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const candidate = rawLine.slice(4).trim();
      filePath = candidate === '/dev/null' ? null : stripDiffPath(candidate);
      continue;
    }

    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }

    if (!filePath || nextLine === 0) continue;
    if (rawLine.startsWith('+')) {
      addedLines.push({ filePath, line: nextLine, text: rawLine.slice(1) });
      nextLine += 1;
    } else if (rawLine.startsWith(' ')) {
      nextLine += 1;
    }
  }

  return addedLines;
}

function findDisallowedMatch(filePath: string, pattern: GuardPattern, text: string): string | null {
  const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`;
  const regex = new RegExp(pattern.regex.source, flags);

  for (const match of text.matchAll(regex)) {
    const token = match[0];
    // For patterns that capture a `value` group (secret-assignment), the allowlist
    // must see only the RHS value — not the key NAME — so EXAMPLE_API_KEY=<real>
    // cannot be suppressed by the word "example" appearing in the key name.
    const allowlistToken = match.groups?.value ?? token;
    if (!isAllowedPatternMatch(filePath, pattern.code, allowlistToken)) {
      return token;
    }
    if (token === '') break;
  }

  return null;
}

function isPackageLockResolvedUrlLine(filePath: string, text: string): boolean {
  return normalizeRepoPath(filePath) === 'package-lock.json'
    && /^\s*"resolved":\s*"https:\/\/registry\.npmjs\.org\//.test(text);
}

export function scanAddedLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    const productionCodePath = /^(?:src|scripts|deploy|console\/src)\//.test(filePath);

    if (isFixtureFile(filePath)) continue;
    if (
      /^(?:src|console\/src)\//.test(filePath)
      && !srcConsoleAllowedFiles.has(filePath)
      && /\bconsole\.(?:debug|error|info|log|warn)\s*\(/.test(line.text)
    ) {
      issues.push({
        code: 'src-console-call',
        message: 'Production source should use the structured logger instead of ad-hoc console calls.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /(?:\benv\s*:\s*process\.env|\.{3}process\.env\b)/.test(line.text)) {
      issues.push({
        code: 'process-env-inheritance',
        message: 'Child processes must use an explicit allowlisted env instead of inheriting process.env.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /\bshell\s*:\s*true\b/.test(line.text)) {
      issues.push({
        code: 'child-process-shell-true',
        message: 'Child process shell mode must not be introduced without an explicit reviewed exception.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (productionCodePath && /\b(?:eval\s*\(|(?:new\s+)?Function\s*\()/.test(line.text)) {
      issues.push({
        code: 'dynamic-code-execution',
        message: 'Dynamic code execution must not be introduced in source, scripts, or deploy code.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    if (isSuppressionComment(line.text) && !hasSuppressionRationaleAndExpiry(line.text)) {
      issues.push({
        code: 'unbounded-suppression',
        message: 'Lint/type suppressions must include a rationale and an expires YYYY-MM-DD marker.',
        filePath: line.filePath,
        line: line.line,
      });
    }
    for (const pattern of addedLinePatterns) {
      if (pattern.code === 'internal-workstream-label' && isPackageLockResolvedUrlLine(filePath, line.text)) {
        continue;
      }
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: pattern.message,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

function isSuppressionComment(text: string): boolean {
  // Concatenated at build time to avoid the bare-suppression hook false-positive
  // on this detector's own source line (the hook greps for the literal token).
  const lintSuppressToken = ['eslint', 'disable'].join('-');
  return new RegExp(`(?:@ts-ignore|@ts-expect-error|@ts-nocheck|${lintSuppressToken}|biome-ignore)`).test(text);
}

function hasSuppressionRationaleAndExpiry(text: string): boolean {
  return /--\s+\S.*\bexpires\s+\d{4}-\d{2}-\d{2}\b/.test(text);
}

export function scanCommitMessage(message: string): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const lines = message.split(/\r?\n/);

  lines.forEach((text, index) => {
    for (const pattern of commitMessagePatterns) {
      if (findDisallowedMatch('', pattern, text)) {
        issues.push({ code: pattern.code, message: pattern.message, line: index + 1 });
      }
    }
  });

  return issues;
}

function stagedDiff(cwd: string): string {
  return git(['diff', '--cached', '--unified=0', '--no-ext-diff'], cwd);
}

function stagedFilePaths(cwd: string): string[] {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);
}

function trackedFiles(cwd: string, filePaths: readonly string[]): string[] {
  const tracked = new Set(git(['ls-files', '-z', '--', ...filePaths], cwd)
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath));

  return filePaths.filter((filePath) => tracked.has(filePath));
}

export function isTrackedSensitiveArtifact(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (trackedSensitiveAllowlist.has(normalized)) return false;
  if (/^\.env(?:\.|$)/.test(normalized)) return true;
  if (/(^|\/)auth_info/.test(normalized)) return true;
  if (/\.(?:db|db-wal|db-shm)$/.test(normalized)) return true;
  if (/\.(?:pem|key)$/.test(normalized)) return true;
  if (/^(?:\.codex|\.tmup-artifacts|artifacts)(?:\/|$)/.test(normalized)) return true;
  if (normalized === '.mcp.json') return true;
  if (/^instances\/[^/]+\/instance\.json$/.test(normalized)) return true;
  if (/^(?:users|groups|\.sweep)\//.test(normalized)) return true;
  return false;
}

function sensitiveArtifactIssues(
  filePaths: readonly string[],
  code: string,
  message: string,
): GuardIssue[] {
  return filePaths
    .filter(isTrackedSensitiveArtifact)
    .map((filePath) => ({
      code,
      filePath,
      message,
    }));
}

function scanStagedSensitiveArtifacts(cwd: string): GuardIssue[] {
  return sensitiveArtifactIssues(
    stagedFilePaths(cwd),
    'staged-sensitive-artifact',
    'Runtime credential, database, key, workspace, or scratch artifact must not be committed.',
  );
}

export function scanContentLines(lines: AddedLine[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const line of lines) {
    const filePath = normalizeRepoPath(line.filePath);
    if (isFixtureFile(filePath)) continue;
    for (const pattern of addedLinePatterns) {
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: pattern.message,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

export function scanTrackedFiles(cwd: string): GuardIssue[] {
  const lines: AddedLine[] = [];

  for (const filePath of trackedFiles(cwd, releaseHygieneFiles)) {
    const content = readFileSync(path.join(cwd, filePath), 'utf8');
    content.split(/\r?\n/).forEach((text, index) => {
      lines.push({ filePath, line: index + 1, text });
    });
  }

  return scanContentLines(lines);
}

// Secret-shaped detector codes — the high-signal subset used for advisory
// history scanning. Hygiene-only patterns (focused-test, console calls, internal
// labels) are intentionally excluded so history scans stay actionable.
const secretPatternCodes = new Set([
  'github-token',
  'anthropic-key',
  'openai-key',
  'pinecone-key',
  'twilio-account-sid',
  'slack-token',
  'private-key',
  'secret-assignment',
  'operator-phone',
  'whatsapp-group-jid',
  'whatsapp-user-jid',
  'personal-email',
]);

const secretPatterns = addedLinePatterns.filter((pattern) => secretPatternCodes.has(pattern.code));

/**
 * Advisory-only: scan added lines of recent commits for leaked secret shapes.
 * Report-only — never mutates exitCode in run() for this mode. Fail-closed: a
 * git/parse failure throws rather than returning a silent empty result.
 */
export function scanCommitHistory(cwd: string, depth: number): GuardIssue[] {
  const shas = git(['log', `-${depth}`, '--format=%H'], cwd)
    .split(/\r?\n/)
    .filter(Boolean);

  const issues: GuardIssue[] = [];
  for (const sha of shas) {
    // --unified=0, no-ext-diff for added lines only; -m flattens merge diffs.
    const diff = git(
      ['show', '--format=', '--unified=0', '--no-ext-diff', '-m', sha],
      cwd,
    );
    for (const line of parseUnifiedDiffAddedLines(diff)) {
      const filePath = normalizeRepoPath(line.filePath);
      if (isFixtureFile(filePath)) continue;
      for (const pattern of secretPatterns) {
        if (findDisallowedMatch(filePath, pattern, line.text)) {
          issues.push({
            code: pattern.code,
            message: `[history ${sha.slice(0, 12)}] ${pattern.message}`,
            filePath: line.filePath,
            line: line.line,
          });
        }
      }
    }
  }

  return issues;
}

function branchCommitShas(cwd: string, mergeBase: string): string[] {
  return git(['log', '--reverse', '--format=%H', `${mergeBase}..HEAD`], cwd)
    .split(/\r?\n/)
    .filter(Boolean);
}

// Raw line-set of a file as it exists at the base ref (origin/main), cached per file.
// Used by the branch-history scan to skip matches byte-identical to already-published
// content. Returns an empty set when the file is absent at the base (every line is then
// genuinely branch-new and must be scanned).
function baseRefFileLines(
  cwd: string,
  baseRef: string,
  filePath: string,
  cache: Map<string, Set<string>>,
): Set<string> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  let lines = new Set<string>();
  // ls-tree is quiet for paths absent at the base (empty output, no stderr), so a
  // branch-new file never emits a `fatal: path ... not in <base>` line. Only read the
  // blob when the path exists at the base.
  let existsAtBase = false;
  try {
    existsAtBase = git(['ls-tree', baseRef, '--', filePath], cwd).trim() !== '';
  } catch {
    existsAtBase = false;
  }
  if (existsAtBase) {
    try {
      lines = new Set(git(['show', `${baseRef}:${filePath}`], cwd).split(/\r?\n/));
    } catch {
      lines = new Set();
    }
  }
  cache.set(filePath, lines);
  return lines;
}

function scanBranchCommitSecretLines(
  cwd: string,
  sha: string,
  baseRef?: string,
  baseLineCache?: Map<string, Set<string>>,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const diff = git(['show', '--format=', '--unified=0', '--no-ext-diff', '-m', sha], cwd);

  for (const line of parseUnifiedDiffAddedLines(diff)) {
    const filePath = normalizeRepoPath(line.filePath);
    if (isFixtureFile(filePath)) continue;
    // Correctness (not a detection weakening): a line byte-identical to the base ref
    // (origin/main) is already-published content, not branch-introduced. Merge commits
    // re-expose the base's own lines as branch-unique per-commit diffs; skipping those
    // removes that false-positive class. A genuinely new secret cannot already exist in
    // origin/main, so every real introduction is still flagged.
    if (
      baseRef
      && baseLineCache
      && baseRefFileLines(cwd, baseRef, line.filePath, baseLineCache).has(line.text)
    ) {
      continue;
    }
    for (const pattern of secretPatterns) {
      if (findDisallowedMatch(filePath, pattern, line.text)) {
        issues.push({
          code: pattern.code,
          message: `[branch history ${sha.slice(0, 12)}] ${pattern.message}`,
          filePath: line.filePath,
          line: line.line,
        });
      }
    }
  }

  return issues;
}

function scanBranchCommitSensitiveArtifacts(cwd: string, sha: string): GuardIssue[] {
  const changedFiles = git(['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMR', '-r', sha], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);

  return sensitiveArtifactIssues(
    changedFiles,
    'branch-history-sensitive-artifact',
    `Runtime credential, database, key, workspace, or scratch artifact was committed in branch history ${sha.slice(0, 12)}.`,
  );
}

export function scanBranchSecretHistory(
  cwd: string,
  mergeBase: string,
  baseRef?: string,
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const baseLineCache = new Map<string, Set<string>>();
  for (const sha of branchCommitShas(cwd, mergeBase)) {
    issues.push(
      ...scanBranchCommitSensitiveArtifacts(cwd, sha),
      ...scanBranchCommitSecretLines(cwd, sha, baseRef, baseLineCache),
    );
  }
  return issues;
}

export function parseCommitAuthorLog(log: string): CommitAuthor[] {
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, name, email, subject, message] = record.split('\x00');
      return {
        sha: sha ?? '',
        name: name ?? '',
        email: email ?? '',
        subject: subject ?? '',
        ...(message === undefined ? {} : { message }),
      };
    })
    .filter((commit) => commit.sha !== '');
}

export function scanCommitAuthors(commits: CommitAuthor[]): GuardIssue[] {
  const issues: GuardIssue[] = [];

  for (const commit of commits) {
    const author = `${commit.name} ${commit.email}`;
    for (const pattern of disallowedCommitAuthorPatterns) {
      if (pattern.regex.test(author)) {
        issues.push({
          code: pattern.code,
          message: `${pattern.message} (${commit.subject || 'no subject'})`,
          filePath: `commit:${commit.sha.slice(0, 12)}`,
        });
        break;
      }
    }

    for (const issue of scanCommitMessage(commit.message ?? commit.subject)) {
      issues.push({
        ...issue,
        message: `${issue.message} (${commit.subject || 'no subject'})`,
        filePath: `commit:${commit.sha.slice(0, 12)}`,
      });
    }
  }

  return issues;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

function branchDiffBaseRef(cwd: string, requestedBaseRef?: string): string | null {
  const explicitBaseRef = requestedBaseRef?.trim();
  if (explicitBaseRef) {
    if (!gitRefExists(cwd, explicitBaseRef)) {
      throw new Error(`--base ref does not exist: ${explicitBaseRef}`);
    }
    return explicitBaseRef;
  }

  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef && gitRefExists(cwd, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  if (gitRefExists(cwd, 'origin/main')) return 'origin/main';

  try {
    const branch = git(['branch', '--show-current'], cwd).trim();
    const upstream = branch
      ? git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], cwd).trim()
      : '';
    if (upstream && gitRefExists(cwd, upstream)) return upstream;
  } catch {
    // Detached or not-yet-published branch with no origin/main mirror.
  }

  return null;
}

function branchMergeBase(cwd: string, baseRef: string): string {
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], cwd).trim();
  if (!mergeBase) {
    throw new Error(`No merge base found between ${baseRef} and HEAD`);
  }
  return mergeBase;
}

export function scanBranchDiff(cwd: string, requestedBaseRef?: string): GuardIssue[] {
  const baseRef = branchDiffBaseRef(cwd, requestedBaseRef);
  if (!baseRef) {
    throw new Error('No branch-diff base ref found; pass --base <ref> or fetch origin/main');
  }

  const mergeBase = branchMergeBase(cwd, baseRef);
  const changedFiles = git(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}..HEAD`], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizeRepoPath);
  const diff = git(['diff', '--unified=0', '--no-ext-diff', `${mergeBase}..HEAD`], cwd);

  const finalDiffIssues = [
    ...sensitiveArtifactIssues(
      changedFiles,
      'branch-sensitive-artifact',
      'Runtime credential, database, key, workspace, or scratch artifact must not be committed in the branch diff.',
    ),
    ...scanAddedLines(parseUnifiedDiffAddedLines(diff)),
  ];
  const finalSensitiveArtifactPaths = new Set(
    finalDiffIssues
      .filter((issue) => issue.code === 'branch-sensitive-artifact' && issue.filePath)
      .map((issue) => issue.filePath),
  );
  const seen = new Set(finalDiffIssues.map((issue) => `${issue.code}:${issue.filePath ?? ''}:${issue.line ?? 0}`));
  const historyIssues = scanBranchSecretHistory(cwd, mergeBase, baseRef)
    .filter((issue) => {
      if (
        issue.code === 'branch-history-sensitive-artifact'
        && issue.filePath
        && finalSensitiveArtifactPaths.has(issue.filePath)
      ) {
        return false;
      }
      const key = `${issue.code}:${issue.filePath ?? ''}:${issue.line ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return [...finalDiffIssues, ...historyIssues];
}

function commitAuthorBaseRef(cwd: string): string | null {
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef && gitRefExists(cwd, `origin/${githubBaseRef}`)) {
    return `origin/${githubBaseRef}`;
  }

  // The public boundary is the default branch, not the branch's own upstream:
  // preferring the upstream made a sync-merge pull already-published main
  // commits into the scan range, so violations that landed upstream blocked
  // unrelated branches from pushing.
  if (gitRefExists(cwd, 'origin/main')) return 'origin/main';

  try {
    const branch = git(['branch', '--show-current'], cwd).trim();
    const upstream = branch
      ? git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`], cwd).trim()
      : '';
    if (upstream && gitRefExists(cwd, upstream)) return upstream;
  } catch {
    // Detached or not-yet-published branch with no origin/main mirror.
  }

  return null;
}

export function readCommitAuthors(cwd: string): CommitAuthor[] {
  const baseRef = commitAuthorBaseRef(cwd);
  if (!baseRef) {
    const log = git(['log', '--format=%H%x00%an%x00%ae%x00%s%x00%B%x1e', '-1', 'HEAD'], cwd);
    return parseCommitAuthorLog(log);
  }
  // Exclude commits already reachable from origin/main.  This matters when the
  // upstream ref lags behind origin/main: without the exclusion, commits that
  // have already merged into main are re-scanned on subsequent branches.
  // Concretely, a GitHub squash-merge appends a GitHub-generated Co-authored-by
  // trailer to the merged commit on origin/main; that merged commit should never
  // enter the scan window for a fresh branch even if baseRef still points to an
  // older upstream tip.  When baseRef IS origin/main the argument is redundant
  // but harmless.
  //
  // NOTE: future squash merges via `gh pr merge --squash` should pass
  // `--body <message>` explicitly to prevent GitHub from appending the
  // generated trailer automatically.
  const excludeArgs = gitRefExists(cwd, 'origin/main') ? ['--not', 'origin/main'] : [];
  const log = git(
    ['log', '--format=%H%x00%an%x00%ae%x00%s%x00%B%x1e', `${baseRef}..HEAD`, ...excludeArgs],
    cwd,
  );
  return parseCommitAuthorLog(log);
}

function printIssues(issues: GuardIssue[]): void {
  for (const issue of issues) {
    const location = issue.filePath
      ? `${issue.filePath}:${issue.line ?? 1}`
      : `commit-msg:${issue.line ?? 1}`;
    console.error(`${location} ${issue.code}: ${issue.message}`);
  }
}

function printHelp(): void {
  console.log(`Usage: npm run guard:repo -- [--staged]
       npm run guard:repo -- --branch-diff [--base <ref>]
       npm run guard:repo -- --release-hygiene
       npm run guard:repo -- --commit-authors
       npm run guard:repo:commit-msg -- <message-file>

Modes:
  --staged              Scan staged added lines. This is the default.
  --branch-diff         Scan added lines from merge-base(base, HEAD)..HEAD.
  --base <ref>          Base ref for --branch-diff (default: origin/<GITHUB_BASE_REF>,
                        then origin/main, then branch upstream).
  --release-hygiene     Scan tracked release-hygiene files.
  --commit-authors      Scan commits in the branch/PR range for placeholder authors
                        and public commit-message hygiene violations.
  --scan-history [N]    Advisory: scan added lines of the last N commits (default 50)
                        for leaked secret shapes. Report-only; exit code stays 0.
  --commit-msg <file>   Scan a commit message file.
  --help                Show this help.

By default, this guard is changed-content only. Use --release-hygiene for the release-hygiene file gate.`);
}

export function run(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): GuardIssue[] {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  if (args.mode === 'scan-history') {
    const depth = args.historyDepth ?? 50;
    // Advisory-only: a git failure (e.g. shallow clone with no history) must NOT
    // fail the build, so we never let the throw reach the top-level exit-1 handler.
    let historyIssues: GuardIssue[];
    try {
      historyIssues = scanCommitHistory(cwd, depth);
    } catch (err) {
      console.error(
        `repo hygiene history scan (advisory): skipped — ${(err as Error).message}`,
      );
      return [];
    }
    if (historyIssues.length > 0) {
      printIssues(historyIssues);
      console.error(
        `repo hygiene history scan (advisory): ${historyIssues.length} secret-shaped finding(s) in last ${depth} commits`,
      );
    } else {
      console.log(`repo hygiene history scan (advisory): no secret shapes in last ${depth} commits`);
    }
    return historyIssues;
  }

  const issues = args.mode === 'commit-msg'
    ? scanCommitMessage(readFileSync(args.messageFile ?? '', 'utf8'))
    : args.mode === 'release-hygiene'
      ? scanTrackedFiles(cwd)
      : args.mode === 'commit-authors'
        ? scanCommitAuthors(readCommitAuthors(cwd))
        : args.mode === 'branch-diff'
          ? scanBranchDiff(cwd, args.baseRef)
          : [
              ...scanStagedSensitiveArtifacts(cwd),
              ...scanAddedLines(parseUnifiedDiffAddedLines(stagedDiff(cwd))),
            ];

  if (issues.length > 0) {
    printIssues(issues);
    process.exitCode = 1;
  } else {
    console.log('repo hygiene guard passed');
  }

  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
