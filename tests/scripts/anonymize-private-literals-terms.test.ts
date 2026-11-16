import { describe, expect, it } from 'vitest';

import { anonymizeText } from '../../scripts/anonymize-private-literals.ts';
import { compilePrivateTerms, loadPrivateTerms, requirePrivateTermsUsable } from '../../scripts/lib/private-terms.ts';
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
    expect(anonymizeText(input)).toEqual({ text: input, replacements: [], refused: [] });
  });
});

describe('anonymizer never creates a new GitHub mention', () => {
  // Mention-shaped tokens are assembled at runtime so this public file never holds one.
  const mention = (login: string): string => ['@', login].join('');
  const personTo = (replace: string) => compilePrivateTerms({
    schema: 'whatsoup-private-terms',
    version: 1,
    terms: [{ id: 'T001', class: 'person', value: 'quorpine', match: 'word', case: 'sensitive', replace }],
  });

  it('keeps a term that follows an @ and reports the refusal by code only', () => {
    const result = anonymizeText(`ping ${mention('zorblab')} today; ssh zorblab; whatsoup@zqline`, rules());
    expect(result.text).toBe(`ping ${mention('zorblab')} today; ssh host-a; whatsoup@line-a`);
    expect(result.refused).toEqual([{ code: 'private-host-label', count: 1, reason: 'would-create-mention' }]);
    expect(result.replacements.map((replacement) => [replacement.code, replacement.count])).toEqual([
      ['private-host-label', 1],
      ['private-instance-label', 1],
    ]);
    const report = JSON.stringify([result.replacements, result.refused]);
    for (const value of ['zorblab', 'zqline']) expect(report).not.toContain(value);
  });

  it('refuses a replacement value that would itself mention a login', () => {
    const result = anonymizeText('ask quorpine', personTo(mention('zqteam')));
    expect(result).toEqual({
      text: 'ask quorpine',
      replacements: [],
      refused: [{ code: 'private-person', count: 1, reason: 'would-create-mention' }],
    });
  });

  it('allows a mention the original text already had, compared case-insensitively', () => {
    const result = anonymizeText(`cc ${mention('ZQteam')}; ask quorpine`, personTo(mention('zqteam')));
    expect(result.text).toBe(`cc ${mention('ZQteam')}; ask ${mention('zqteam')}`);
    expect(result.refused).toEqual([]);
  });
});
