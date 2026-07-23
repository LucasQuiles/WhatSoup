import { describe, expect, it } from 'vitest';

import { isAllowedPatternMatch, scanCommitMessage, scanContentLines } from '../../scripts/repo-hygiene-guard.ts';
import { scanTextForPrivateLiterals } from '../../scripts/publication-guard.ts';

// Lives apart from repo-hygiene-guard.test.ts on purpose: that suite carries
// credential-shaped fixtures for its own detection cases, so editing tools that
// scan for secrets refuse to write to it. Keeping this rule's cases in a
// fixture-free file keeps them editable.
//
// Routable addresses below are composed at runtime rather than written as
// literals — the guard under test scans this very file, and a literal routable
// address here is exactly the finding it is supposed to raise. Same technique the
// sibling suite uses for private host labels and tailnet IPs.
const routableFixture = (local: string, domain: string): string => [local, domain].join('@');

describe('repo hygiene guard — documentation email fixtures', () => {
  it('treats RFC 2606 reserved documentation domains as fixtures, not personal email', () => {
    // Reserved documentation domains cannot resolve to a real inbox, so an address
    // in one is a fixture by construction — the email analogue of the existing
    // phone and Twilio SID fixture allowances. Transports needing an email fixture
    // (an iMessage AppleID sender) previously had no legal way to write one.
    for (const token of [
      'appleid@example.com',
      'ops@mail.example.net',
      'sender@bb.example.test',
      'someone@host.invalid',
    ]) {
      expect(isAllowedPatternMatch('src/example.ts', 'personal-email', token)).toBe(true);
    }
  });

  it('still flags routable domains, including ones that merely embed a reserved name', () => {
    for (const token of [
      routableFixture('someone', 'icloud.com'),
      routableFixture('person', 'gmail.com'),
      routableFixture('user', 'example.com.evil.net'),
    ]) {
      expect(isAllowedPatternMatch('src/example.ts', 'personal-email', token)).toBe(false);
    }
  });

  it('does not extend the fixture allowance to commit messages', () => {
    // Commit messages scan with an empty filePath. History text has no legitimate
    // need for an email fixture, so the allowance is deliberately file-content only.
    expect(isAllowedPatternMatch('', 'personal-email', 'appleid@example.com')).toBe(false);

    const issues = scanCommitMessage('test: add contact\n\nContact appleid@example.com for help.\n');
    expect(issues.map((issue) => issue.code)).toContain('personal-email');
  });

  it('fires end-to-end on a routable address while ignoring the fixture on the same file', () => {
    const issues = scanContentLines([
      { filePath: 'src/example.ts', line: 1, text: 'const sender = "appleid@example.com";' },
      { filePath: 'src/example.ts', line: 2, text: `const owner = "${routableFixture('somebody', 'icloud.com')}";` },
    ]);

    expect(issues.filter((issue) => issue.code === 'personal-email').map((issue) => issue.line)).toEqual([2]);
  });

  it('keeps routable iMessage identities blocking in both canonical guards', () => {
    const filePath = 'tests/transport/imessage/adapter-send.test.ts';
    const token = routableFixture('somebody', 'icloud.com');
    const line = `const recipient = "${token}";`;

    expect(scanContentLines([{ filePath, line: 1, text: line }]).map((issue) => issue.code)).toContain(
      'personal-email',
    );
    expect(scanTextForPrivateLiterals(filePath, line).map((issue) => issue.code)).toContain('personal-email');
  });

  it('keeps reserved iMessage identities safe in both canonical guards', () => {
    const filePath = 'tests/transport/imessage/adapter-send.test.ts';
    const line = 'const recipient = "somebody@example.com";';

    expect(scanContentLines([{ filePath, line: 1, text: line }])).toEqual([]);
    expect(scanTextForPrivateLiterals(filePath, line)).toEqual([]);
  });

  it('does not hide non-email findings in the iMessage test subtree', () => {
    const filePath = 'tests/transport/imessage/adapter-send.test.ts';
    const token = ['ghp_', 'abcdefghijklmnop'].join('');
    const issues = scanContentLines([{ filePath, line: 1, text: `const token = "${token}";` }]);

    expect(issues.map((issue) => issue.code)).toContain('github-token');
  });

  it('keeps phone-shape policy active in the iMessage test subtree', () => {
    const filePath = 'tests/transport/imessage/types.test.ts';
    const routablePhone = ['+44', '7911123456'].join('');
    const unsafe = scanContentLines([{ filePath, line: 1, text: `const sender = "${routablePhone}";` }]);
    const safe = scanContentLines([{ filePath, line: 2, text: 'const sender = "+447700912345";' }]);

    expect(unsafe.map((issue) => issue.code)).toContain('operator-phone');
    expect(safe.map((issue) => issue.code)).not.toContain('operator-phone');
  });
});
