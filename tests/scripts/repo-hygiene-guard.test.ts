import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  parseUnifiedDiffAddedLines,
  scanAddedLines,
  scanCommitMessage,
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
      { filePath: 'tests/example.test.ts', line: 14, text: 'const group = "15551234@g.us";' },
    ]);

    expect(issues).toEqual([]);
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

  it('parses staged and commit-message modes', () => {
    expect(parseArgs([])).toEqual({ mode: 'staged', help: false });
    expect(parseArgs(['--staged'])).toEqual({ mode: 'staged', help: false });
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
