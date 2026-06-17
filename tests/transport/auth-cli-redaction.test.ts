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
    expect(source).toContain('redactAuthCliText(err instanceof Error ? err.message : String(err))');
    expect(source).not.toContain('Authenticated successfully as ${jid}');
    expect(source).not.toContain('Auth directory: ${config.authDir}');
  });
});
