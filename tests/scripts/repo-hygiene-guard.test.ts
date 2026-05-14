import { describe, expect, it } from 'vitest';

import {
  isTrackedSensitiveArtifact,
  parseArgs,
  parseUnifiedDiffAddedLines,
  scanAddedLines,
  scanCommitMessage,
  scanContentLines,
} from '../../scripts/repo-hygiene-guard.ts';

describe('repo hygiene guard', () => {
  it('parses added lines and target line numbers from unified diffs', () => {
    const lines = parseUnifiedDiffAddedLines(`diff --git a/tests/example.test.ts b/tests/example.test.ts
--- a/tests/example.test.ts
+++ b/tests/example.test.ts
@@ -4,0 +5,3 @@
+const first = true;
+const second = true;
 context line
@@ -20,0 +24,1 @@
+const third = true;
`);

    expect(lines).toEqual([
      { filePath: 'tests/example.test.ts', line: 5, text: 'const first = true;' },
      { filePath: 'tests/example.test.ts', line: 6, text: 'const second = true;' },
      { filePath: 'tests/example.test.ts', line: 24, text: 'const third = true;' },
    ]);
  });

  it('flags focused tests and real-shaped group identifiers in staged added lines', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 10, text: 'it.only("runs one case", () => {})' },
      { filePath: 'tests/example.test.ts', line: 11, text: 'const group = "1203631234567890@g.us";' },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['focused-test', 'whatsapp-group-jid']);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual([
      'tests/example.test.ts:10',
      'tests/example.test.ts:11',
    ]);
  });

  it('allows synthetic user and group fixtures', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 12, text: 'const user = "15551234@s.whatsapp.net";' },
      { filePath: 'tests/example.test.ts', line: 13, text: 'const lid = "11111119999@lid";' },
      { filePath: 'tests/example.test.ts', line: 14, text: 'const group = "120363555555555000@g.us";' },
    ]);

    expect(issues).toEqual([]);
  });

  it('blocks real-shaped group JIDs that share the synthetic fixture prefix', () => {
    const issues = scanAddedLines([
      { filePath: 'tests/example.test.ts', line: 15, text: 'const group = "120363555123456789@g.us";' },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('allows detector literals in the guard fixture files only', () => {
    const fixtureIssues = scanAddedLines([
      {
        filePath: 'tests/scripts/repo-hygiene-guard.test.ts',
        line: 20,
        text: 'const detectorFixture = "Co-Authored-By: Test <person@example.com>";',
      },
      {
        filePath: 'scripts/repo-hygiene-guard.ts',
        line: 20,
        text: 'const detectorFixture = "1203631234567890@g.us";',
      },
    ]);
    const normalIssues = scanAddedLines([
      {
        filePath: 'tests/other.test.ts',
        line: 20,
        text: 'const detectorFixture = "1203631234567890@g.us";',
      },
    ]);

    expect(fixtureIssues).toEqual([]);
    expect(normalIssues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('flags private instance labels in content scans', () => {
    const issues = scanContentLines([
      {
        filePath: 'scripts/example.sh',
        line: 1,
        text: 'systemctl --user start whatsoup@q',
      },
      {
        filePath: 'src/example.ts',
        line: 2,
        text: "const channel = 'whatsapp:mw-bot';",
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'private-instance-label',
      'private-instance-label',
    ]);
  });

  it('allows operational script labels without suppressing group JID detection', () => {
    const issues = scanAddedLines([
      {
        filePath: 'scripts/cutover.sh',
        line: 94,
        text: 'systemctl --user start whatsoup@q',
      },
      {
        filePath: 'scripts/cutover.sh',
        line: 95,
        text: 'echo "120363555123456789@g.us"',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('allows bare release env var names without hiding private labels', () => {
    const envOnlyIssues = scanContentLines([
      {
        filePath: 'src/example.ts',
        line: 1,
        text: 'ALLOW_M365_MUTATIONS',
      },
    ]);
    const mixedIssues = scanContentLines([
      {
        filePath: 'src/example.ts',
        line: 2,
        text: 'mw-bot has ALLOW_M365_MUTATIONS=1',
      },
    ]);

    expect(envOnlyIssues).toEqual([]);
    expect(mixedIssues.map((issue) => issue.code)).toEqual(['private-instance-label']);
  });

  it('scans full-tree content without enforcing staged-only source console checks', () => {
    const issues = scanContentLines([
      {
        filePath: 'src/fleet/routes/example.ts',
        line: 1,
        text: 'console.log("existing operational entrypoint");',
      },
      {
        filePath: 'docs/example.md',
        line: 2,
        text: 'Generated with GPT.',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(['model-attribution']);
  });

  it('blocks new ad-hoc console logging in production source files', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/fleet/routes/example.ts',
        line: 42,
        text: 'console.log("debug route payload", payload);',
      },
      {
        filePath: 'src/runtimes/chat/runtime.ts',
        line: 77,
        text: 'console.error("chat failed", err);',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'src-console-call',
      'src-console-call',
    ]);
    expect(issues.map((issue) => `${issue.filePath}:${issue.line}`)).toEqual([
      'src/fleet/routes/example.ts:42',
      'src/runtimes/chat/runtime.ts:77',
    ]);
  });

  it('allows existing CLI and bootstrap console entrypoints', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/bootstrap.ts',
        line: 11,
        text: 'console.error(err instanceof Error ? err.message : String(err));',
      },
      {
        filePath: 'src/bootstrap-auth.ts',
        line: 10,
        text: 'console.error(err instanceof Error ? err.message : String(err));',
      },
      {
        filePath: 'src/transport/auth.ts',
        line: 27,
        text: 'console.error("Starting WhatsApp authentication...");',
      },
      {
        filePath: 'src/fleet/standalone.ts',
        line: 27,
        text: 'console.log("Fleet server listening");',
      },
      {
        filePath: 'src/config.ts',
        line: 440,
        text: 'console.warn(payload, message);',
      },
    ]);

    expect(issues).toEqual([]);
  });

  it('blocks staged child-process hazards, debuggers, and unbounded suppressions', () => {
    const issues = scanAddedLines([
      {
        filePath: 'src/process-runner.ts',
        line: 1,
        text: 'spawn("node", [], { env: { ...process.env } });',
      },
      {
        filePath: 'scripts/run-task.ts',
        line: 2,
        text: 'spawn("node", [], { shell: true });',
      },
      {
        filePath: 'console/src/runner.ts',
        line: 3,
        text: 'const compiled = Function(source);',
      },
      {
        filePath: 'src/handler.ts',
        line: 4,
        text: 'debugger;',
      },
      {
        filePath: 'src/types.ts',
        line: 5,
        text: '// @ts-expect-error',
      },
      {
        filePath: 'src/types.ts',
        line: 6,
        text: '// @ts-expect-error -- upstream type is narrower than runtime payload; expires 2026-12-31',
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual([
      'process-env-inheritance',
      'child-process-shell-true',
      'dynamic-code-execution',
      'debugger-statement',
      'unbounded-suppression',
    ]);
    expect(issues.some((issue) => issue.line === 6)).toBe(false);
  });

  it('classifies staged runtime artifacts as sensitive without blocking tracked settings template', () => {
    expect(isTrackedSensitiveArtifact('.env')).toBe(true);
    expect(isTrackedSensitiveArtifact('.env.local')).toBe(true);
    expect(isTrackedSensitiveArtifact('.env.example')).toBe(false);
    expect(isTrackedSensitiveArtifact('.mcp.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('.tmup-artifacts/task/output.md')).toBe(true);
    expect(isTrackedSensitiveArtifact('artifacts/private-screenshot.png')).toBe(true);
    expect(isTrackedSensitiveArtifact('instances/test/instance.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('users/chat/auth_info_baileys/creds.json')).toBe(true);
    expect(isTrackedSensitiveArtifact('bot.db')).toBe(true);
    expect(isTrackedSensitiveArtifact('certs/private.pem')).toBe(true);
    expect(isTrackedSensitiveArtifact('.claude/settings.json')).toBe(false);
  });

  it('flags public-history hygiene problems in commit messages', () => {
    const issues = scanCommitMessage(`feat(test): add coverage

Generated with GPT.
Co-Authored-By: Person <person@example.com>
`);

    expect(issues.map((issue) => issue.code)).toEqual([
      'model-attribution',
      'commit-coauthor-trailer',
      'personal-email',
    ]);
    expect(issues.map((issue) => issue.line)).toEqual([3, 4, 4]);
  });

  it('allows messaging-address right-hand sides while flagging personal emails in commit messages', () => {
    const messagingIssues = scanCommitMessage(`test: add address fixtures

Fixture contact: 15551234567@c.us
Fixture contact: 15551234567@s.whatsapp.net
Fixture contact: 11111119999@lid
`);
    const personalIssues = scanCommitMessage(`test: add contact

Contact dev@example.net for help.
`);

    expect(messagingIssues).toEqual([]);
    expect(personalIssues.map((issue) => issue.code)).toEqual(['personal-email']);
  });

  it('allows synthetic group JIDs in commit messages while blocking real-shaped ones', () => {
    const syntheticIssues = scanCommitMessage(`fix(guard): allow synthetic group examples

Allows 120363555555555000@g.us as documentation fixture text.
`);
    const realIssues = scanCommitMessage(`fix(guard): document migrated group

The migrated group was 1203631234567890@g.us.
`);

    expect(syntheticIssues).toEqual([]);
    expect(realIssues.map((issue) => issue.code)).toEqual(['whatsapp-group-jid']);
  });

  it('parses staged and commit-message modes', () => {
    expect(parseArgs([])).toEqual({ mode: 'staged', help: false });
    expect(parseArgs(['--staged'])).toEqual({ mode: 'staged', help: false });
    expect(parseArgs(['--release-hygiene'])).toEqual({ mode: 'release-hygiene', help: false });
    expect(parseArgs(['--commit-msg', '.git/COMMIT_EDITMSG'])).toEqual({
      mode: 'commit-msg',
      messageFile: '.git/COMMIT_EDITMSG',
      help: false,
    });
    expect(parseArgs(['--commit-msg', '--help'])).toEqual({
      mode: 'commit-msg',
      help: true,
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});
