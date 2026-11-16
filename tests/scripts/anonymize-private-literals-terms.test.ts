import { describe, expect, it } from 'vitest';

import { anonymizeText } from '../../scripts/anonymize-private-literals.ts';
import { loadPrivateTerms, requirePrivateTermsUsable } from '../../scripts/lib/private-terms.ts';
import { SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';

const rules = () => requirePrivateTermsUsable(loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE }));
const input = 'ssh zorblab; ssh zmini7; restart qx_bot; whatsoup@zqline; zqline alone; ask Quorpine; mail.corp-zz.example; 100.1.2.3';

describe('anonymizer with a private term file', () => {
  it('replaces each term with its own replacement, expanding the first regex group', () => {
    const result = anonymizeText(input, rules());
    expect(result.text).toBe(
      'ssh host-a; ssh host-7; restart bot-a; whatsoup@line-a; zqline alone; ask user-a; mail.corp.example; 192.0.2.1',
    );
    expect([...new Set(result.replacements.map((replacement) => replacement.code))]).toEqual([
      'private-domain',
      'private-host-label',
      'private-instance-label',
      'private-person',
      'private-tailnet-ip',
    ]);
    const report = JSON.stringify(result.replacements);
    for (const value of ['zorblab', 'zmini7', 'qx_bot', 'zqline', 'Quorpine', 'corp-zz.example', '100.1.2.3']) {
      expect(report).not.toContain(value);
    }
  });

  it('behaves as before without a term file', () => {
    expect(anonymizeText(input)).toEqual({ text: input, replacements: [] });
  });
});
