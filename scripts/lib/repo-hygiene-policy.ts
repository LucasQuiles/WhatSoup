import {
  isDocumentationEmailFixture,
  isGitHubSshTransportPrincipal,
  isOperationalProtocolToken,
  normalizeRepoPath,
  operationalReleaseHygieneFiles,
} from './guard-core.ts';

export interface GuardPattern {
  code: string;
  message: string;
  regex: RegExp;
}

export const projectedFileSecretFixtureFiles = [
  'scripts/anonymize-private-literals.ts',
  'scripts/lib/repo-hygiene-policy.ts',
  'scripts/repo-hygiene-guard.ts',
  'tests/scripts/anonymize-private-literals.test.ts',
  'tests/scripts/repo-hygiene-guard.test.ts',
] as const;
export const projectedFileSecretFixtureFileSet = new Set<string>(projectedFileSecretFixtureFiles);

export const fixtureFiles = new Set([
  ...projectedFileSecretFixtureFiles,
  'tests/eslint-rules/categorized-skips.test.ts',
  // BEAD-052 redaction-parity corpus: intentionally secret-, email-, and
  // path-SHAPED inputs that exercise the bot-errors redactor on both the TS and
  // Python sides. NOTE: no external secret scanner backstops this repo (the
  // repo hooksPath shadows the global git hooks; CI runs none) - keep this
  // blanket set minimal and prefer the code-scoped
  // selfReferentialAllowlistFiles mechanism below.
  'tests/fixtures/redaction-parity-corpus.jsonl',
]);

// The CAPE agent-runtime probe suite (tools/agent-runtime-probes/) is security/masking tooling:
// its corpus is intentionally secret-, email-, and path-SHAPED test fixtures. Treat the whole
// subtree as fixtures for these hygiene SHAPE patterns; the suite's own corpus_guard /
// sensitive_pattern_loader covers its corpus. NOTE: no external secret scanner backstops this
// repo (the repo hooksPath shadows the global git hooks) - keep exemptions minimal.
export const isFixtureFile = (filePath: string): boolean =>
  fixtureFiles.has(filePath)
  || filePath.startsWith('tools/agent-runtime-probes/');

// Files that necessarily contain the operational allowlist's own private-SHAPED
// literals: the shared allowlist source in lib, and the publication-guard test
// that exercises those literals. Exempt ONLY the codes their own content
// legitimately trips - every other pattern class (keys, secrets, phones,
// tailnet IPs, JIDs) stays fully enforced on them, unlike blanket fixtureFiles
// membership.
export const selfReferentialAllowlistFiles = new Set([
  'scripts/lib/guard-core.ts',
  'tests/scripts/publication-guard.test.ts',
]);
export const selfReferentialAllowedCodes = new Set([
  'personal-email',
  'private-instance-label',
  'private-host-label',
]);

export const releaseHygieneFiles = [
  'scripts/cutover.sh',
  'scripts/migrate-namespace.sh',
  'scripts/soak-check.sh',
  'src/runtimes/agent/providers/child-env.ts',
  'src/transport/contract/capabilities.ts',
];

export const allowedEnvVarNameToken = /^[A-Z][A-Z0-9_]+_(?:MUTATIONS|TOKEN|KEY|URL|PATH)$/;
export const allowedMessagingAddressRhs = /@(?:s\.whatsapp\.net|c\.us|lid)$/i;

// Reserved documentation-domain fixtures are defined once in guard-core so this
// guard and publication-guard cannot disagree about the same token.

// SSOT for the fleet private-host labels: the publication detection rule below,
// and consumers like the bot-errors collector-unit hygiene test, import this.
export const privateHostLabels = [
  ['mw', 'lab'],
  ['nuc', 'les'],
  ['ana', 'bot'],
  ['mac', 'lab'],
].map((parts) => parts.join(''));
export const privateTailnetIps = [
  ['100', '91', '13', '7'],
  ['100', '84', '79', '77'],
].map((parts) => parts.join('.'));

export const trackedSensitiveAllowlist = new Set(['.env.example', '.claude/settings.json']);
export const trackedSensitiveArtifactPatterns = [
  /^\.env(?:\.|$)/,
  /(^|\/)auth_info/,
  /\.(?:db|db-wal|db-shm)$/,
  /\.(?:pem|key)$/,
  /^(?:\.codex|\.tmup-artifacts|artifacts)(?:\/|$)/,
  /^instances\/[^/]+\/instance\.json$/,
  /^(?:users|groups|\.sweep)\//,
];

// Reserved/fictional phone ranges that are safe as test fixtures and documentation:
//   - North American 555-line numbers (NANP reserved-for-fiction, e.g. +1 415 555 0100)
//   - Repo synthetic fixtures: 1555*, 1111111*, 1000000000* (console/test fixtures)
//   - Obvious placeholders: +1234567890, +0...
//   - UK Ofcom drama range +447700 9xxxxx
//   - 15551230008 / 15551230006: repo-wide canonical synthetic test fixtures
//     (used as conversationKey/JID fixtures across tests/core/*; not a real line).
export const allowedPhoneFixture = /^\+(?:1?(?:\d{3})?555\d{4}|1555\d+|1111111\d*|1?0{6,}\d*|1234567890|0+|44770[09]\d{6}|99990{0,4}\d+|1415555\d+|1999900\d+|1?5551230008|1?5551230006)$/;
// Twilio Account SID fixtures: all-zero / repeated-char placeholder bodies.
export const allowedTwilioSidFixture = /^AC(?:0{32}|x{32}|X{32}|(?:0123456789abcdef){2})$/;
// Provider-key fixtures: explicit test/mock/fake/example markers within the token.
// Markers are delimiter-anchored so a real key body that merely CONTAINS the
// substring "sample"/"dummy" (e.g. base64 ...Sample...) is not allowlisted.
export const allowedProviderKeyFixture = /(?:[_-]test[_-]|^sk-test|^pcsk_test|[_-](?:mock|fake|fixture|example|placeholder|redacted|dummy|sample)(?:[_-]|$))/i;
// Obvious non-secret values for the high-entropy secret-assignment pattern:
// redaction markers, placeholders, and low-entropy/repeated fixtures. Provider
// prefixed keys (sk-ant-, pcsk_, ghp_, AC...) are caught by their dedicated
// value-shape patterns, so secret-assignment only needs the keyword-bound
// high-entropy residual class.
export const allowedSecretAssignmentValue = /(?:redacted|placeholder|example|changeme|your[_-]|dummy|fake|sample|notarealkey|should-be-overridden|0{8,}|(?:0123456789){2}|abcdefabcdef)/i;

export const disallowedCommitAuthorPatterns: GuardPattern[] = [
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

export function isAllowedPatternMatch(filePath: string, code: string, token: string): boolean {
  if (allowedEnvVarNameToken.test(token)) return true;
  if (code === 'personal-email' && allowedMessagingAddressRhs.test(token)) return true;
  if (code === 'personal-email' && isGitHubSshTransportPrincipal(token)) return true;
  // GitHub's support service mailbox appears in every dependabot commit's
  // Signed-off-by trailer; it is organizational, never personal. Exact-token
  // gated (mirroring the SSH-principal allowance) so mailbox detection for
  // any other github.com address is unchanged.
  if (code === 'personal-email' && token.toLowerCase() === 'support@github.com') return true;
  // File content only. scanCommitMessage scans with an empty filePath, and a commit
  // message never legitimately carries an email fixture — so the documentation-domain
  // allowance must not reach it, or history text would silently gain an email escape.
  if (code === 'personal-email' && filePath !== '' && isDocumentationEmailFixture(token)) return true;
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
  if (selfReferentialAllowlistFiles.has(filePath) && selfReferentialAllowedCodes.has(code)) {
    return true;
  }
  // Operational health-profile / fleet-manifest files legitimately reference
  // real systemd template-unit names, which the email-shape regex matches.
  // The shared guard-core helper tolerates the trailing ".service" suffix.
  // Code-gated: this bypass exists only for the email and instance-label
  // shapes those unit names produce, never for key/secret/phone/IP classes.
  if (
    (code === 'personal-email' || code === 'private-instance-label')
    && operationalReleaseHygieneFiles.has(filePath)
    && isOperationalProtocolToken(token)
  ) {
    return true;
  }
  return false;
}

export const srcConsoleAllowedFiles = new Set([
  'src/bootstrap.ts',
  'src/bootstrap-auth.ts',
  'src/config.ts',
  'src/fleet/standalone.ts',
  'src/transport/auth.ts',
  // T5 b-12: the perf meter is itself the diagnostics surface (19-§2
  // runtime instrumentation); its sampled notes go to the dev console by
  // design, and the structured logger is server-side only.
  'console/src/lib/perf.ts',
]);

export const addedLinePatterns: GuardPattern[] = [
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
    code: 'todo-test',
    message: 'Todo tests must not be committed.',
    regex: /\b(?:describe|it|test)\.todo(?:\s*\(|\.)/,
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
    regex: /\b[A-Z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|s\.whatsapp\.net|g\.us|heal\.internal)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
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
    code: 'supabase-secret',
    message: 'Public repo text must not include Supabase secret key shapes.',
    regex: /(?<![A-Za-z0-9_-])sb_secret_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/,
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

export const projectedFileSecretPatternCodes = [
  'anthropic-key',
  'openai-key',
  'pinecone-key',
  'private-key',
  'supabase-secret',
] as const;
const projectedFileSecretPatternCodeSet = new Set<string>(projectedFileSecretPatternCodes);
export const projectedFileSecretPatterns = addedLinePatterns.filter((pattern) =>
  projectedFileSecretPatternCodeSet.has(pattern.code),
);

export const commitMessagePatterns: GuardPattern[] = [
  {
    code: 'commit-coauthor-trailer',
    message: 'Public commits must not include Co-Authored-By trailers.',
    regex: /^Co-Authored-By:/i,
  },
  ...addedLinePatterns.filter((pattern) => pattern.code !== 'merge-conflict-marker'),
];

export interface GuardPatternMatch {
  token: string;
  allowlistToken: string;
}

export function patternMatches(pattern: GuardPattern, text: string): GuardPatternMatch[] {
  const flags = pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`;
  const regex = new RegExp(pattern.regex.source, flags);
  const matches: GuardPatternMatch[] = [];

  for (const match of text.matchAll(regex)) {
    const token = match[0];
    // For patterns that capture a `value` group (secret-assignment), the allowlist
    // must see only the RHS value — not the key NAME — so EXAMPLE_API_KEY=<real>
    // cannot be suppressed by the word "example" appearing in the key name.
    const allowlistToken = match.groups?.value ?? token;
    matches.push({ token, allowlistToken });
    if (token === '') break;
  }

  return matches;
}

export function findDisallowedMatch(filePath: string, pattern: GuardPattern, text: string): string | null {
  for (const match of patternMatches(pattern, text)) {
    if (!isAllowedPatternMatch(filePath, pattern.code, match.allowlistToken)) {
      return match.token;
    }
  }

  return null;
}

export function isPackageLockResolvedUrlLine(filePath: string, text: string): boolean {
  return normalizeRepoPath(filePath) === 'package-lock.json'
    && /^\s*"resolved":\s*"https:\/\/registry\.npmjs\.org\//.test(text);
}

export function isProductionCodePath(filePath: string): boolean {
  return /^(?:src|scripts|deploy|console\/src)\//.test(filePath);
}

export function isSourceConsoleCall(filePath: string, text: string): boolean {
  return /^(?:src|console\/src)\//.test(filePath)
    && !srcConsoleAllowedFiles.has(filePath)
    && /\bconsole\.(?:debug|error|info|log|warn)\s*\(/.test(text);
}

export function isProcessEnvInheritance(text: string): boolean {
  return /(?:\benv\s*:\s*process\.env|\.{3}process\.env\b)/.test(text);
}

export function isChildProcessShellTrue(text: string): boolean {
  return /\bshell\s*:\s*true\b/.test(text);
}

export function isDynamicCodeExecution(text: string): boolean {
  return /\b(?:eval\s*\(|(?:new\s+)?Function\s*\()/.test(text);
}
