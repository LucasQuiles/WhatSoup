import { describe, expect, it } from 'vitest';

import { assertNoSecretLike } from '../../scripts/artifact-redaction.ts';

function rawGroupJid(): string {
  return ['120363', '123456789012', '@g.us'].join('');
}

function rawPhoneJid(): string {
  return ['15551234567', '@s.whatsapp.net'].join('');
}

function rawLid(): string {
  return ['123456789012345', '@lid'].join('');
}

describe('artifact redaction guard', () => {
  it('rejects raw WhatsApp chat identifiers in proof artifacts', () => {
    expect(() => assertNoSecretLike(`target=${rawGroupJid()}`, 'artifact')).toThrow(
      /redaction_violation/,
    );
    expect(() => assertNoSecretLike(`sender=${rawPhoneJid()}`, 'artifact')).toThrow(
      /redaction_violation/,
    );
    expect(() => assertNoSecretLike(`actor=${rawLid()}`, 'artifact')).toThrow(
      /redaction_violation/,
    );
  });

  it('allows redacted WhatsApp labels that do not expose raw identifiers', () => {
    expect(() => assertNoSecretLike('target=120363...@g.us', 'artifact')).not.toThrow();
    expect(() => assertNoSecretLike('phone=[REDACTED PHONE]', 'artifact')).not.toThrow();
    expect(() => assertNoSecretLike('chat=<masked-group-jid>', 'artifact')).not.toThrow();
  });
});
