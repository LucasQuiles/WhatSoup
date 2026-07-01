import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { redactAuthCliText } from '../../src/transport/auth-cli-redaction.ts';

describe('auth CLI redaction', () => {
  it('redacts authenticated JIDs, credential paths, and secret-shaped failures', () => {
    const raw = [
      'Authenticated successfully as 15555550123:1@s.whatsapp.net',
      'Auth directory: /home/testuser/.config/whatsoup/instances/agent-beta/auth',
      'backup=/home/testuser/.local/state/whatsoup/auth-bond-backups/agent-beta/latest',
      'failed token=super-secret Authorization: Bearer abc.def',
      ['url=https://user:pass@', 'fixture.invalid/path'].join(''),
    ].join('\n');

    const redacted = redactAuthCliText(raw);

    expect(redacted).toContain('[REDACTED WHATSAPP JID]');
    expect(redacted).toContain('[REDACTED CREDENTIAL PATH]');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain(['https://[REDACTED]@', 'fixture.invalid/path'].join(''));
    expect(redacted).not.toContain('15555550123');
    expect(redacted).not.toContain('/home/testuser/.config/whatsoup');
    expect(redacted).not.toContain('auth-bond-backups/agent-beta');
    expect(redacted).not.toContain('super-secret');
    expect(redacted).not.toContain('user:pass');
  });

  it('normalizes nullish values to an empty redacted string', () => {
    expect(redactAuthCliText(null)).toBe('');
    expect(redactAuthCliText(undefined)).toBe('');
  });

  it('keeps auth.ts stderr identity and auth-dir logs behind the redactor', () => {
    const source = readFileSync(join(process.cwd(), 'src/transport/auth.ts'), 'utf8');

    expect(source).toContain('redactAuthCliText(jid)');
    expect(source).toContain('redactAuthCliText(config.authDir)');
    expect(source).toContain('redactAuthCliText(errorMessage(err))');
    expect(source).not.toContain('Authenticated successfully as ${jid}');
    expect(source).not.toContain('Auth directory: ${config.authDir}');
  });

  it('redacts the full credential path including parent directories (no username leak)', () => {
    const redacted = redactAuthCliText('Auth directory: /home/testuser/.config/whatsoup/instances/agent-beta/auth');
    expect(redacted).toBe('Auth directory: [REDACTED CREDENTIAL PATH]');
    expect(redacted).not.toContain('testuser');
    expect(redacted).not.toContain('home');
  });

  it('does not over-redact a leading assignment label or preceding word', () => {
    expect(redactAuthCliText('backup=/home/testuser/.config/whatsoup/x')).toBe('backup=[REDACTED CREDENTIAL PATH]');
    expect(redactAuthCliText('see word/secrets.env here')).toBe('see word[REDACTED CREDENTIAL PATH] here');
  });

  it('redacts .config/secrets/ and .env* credential paths (BEAD-051)', () => {
    expect(redactAuthCliText('~/.config/secrets/token')).toBe('[REDACTED CREDENTIAL PATH]');
    expect(redactAuthCliText('reading /home/testuser/.config/secrets/foo failed')).toBe(
      'reading [REDACTED CREDENTIAL PATH] failed',
    );
    expect(redactAuthCliText('/home/testuser/.env')).toBe('[REDACTED CREDENTIAL PATH]');
    expect(redactAuthCliText('see /home/testuser/.env.production here')).toBe(
      'see [REDACTED CREDENTIAL PATH] here',
    );
  });

  it('does not over-redact .env-adjacent non-credential paths (BEAD-051)', () => {
    expect(redactAuthCliText('/home/testuser/.environment')).toBe('/home/testuser/.environment');
    expect(redactAuthCliText('app.env-old')).toBe('app.env-old');
    expect(redactAuthCliText('.eslintrc')).toBe('.eslintrc');
  });

  it('completes in linear time on adversarial path-like input (ReDoS guard)', () => {
    // CREDENTIAL_PATH previously used a nested quantifier (`(?:~|/[^...]+)*`) that
    // backtracked exponentially on strings starting with '/' and repeating '!/'.
    const adversarial = '/' + '!/'.repeat(31);
    const start = performance.now();
    const out = redactAuthCliText(adversarial);
    const elapsedMs = performance.now() - start;
    expect(out).toBe(adversarial); // no credential suffix → unchanged
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe('auth CLI redaction — compound/camelCase secret keys (QR-080)', () => {
  // Fixture VALUES carry an `example` marker so the repo-hygiene secret-assignment
  // guard treats them as obvious non-secrets; still 8+ char single tokens so the
  // redactor's value match fires.
  const LEAKED_BEFORE: Array<[string, string]> = [
    ['AWS multi-underscore', 'AWS_SESSION_TOKEN=exampleAwsSessionTokenValue01'],
    ['camelCase session', 'sessionToken=exampleSessionTokenValue02'],
    ['camelCase bearer', 'bearerToken=exampleBearerTokenValue03'],
    ['aws secret access key', 'aws_secret_access_key=exampleAwsSecretAccessKey04'],
  ];
  it.each(LEAKED_BEFORE)('redacts compound/camelCase secret in failure text: %s', (_l, input) => {
    const out = redactAuthCliText(`Auth failed: ${input}`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(input.split('=')[1]);
  });
  it('still redacts the original keys (no regression)', () => {
    expect(redactAuthCliText('token=exampleBareTokenValue05')).toContain('[REDACTED]');
    expect(redactAuthCliText('client_secret=exampleClientSecretValue06')).toContain('[REDACTED]');
  });
  it.each(['retry_count=12345678', 'patch=v2', 'a session_id field'])(
    'does not over-redact benign text: %s',
    (input) => { expect(redactAuthCliText(input)).toBe(input); },
  );
});
