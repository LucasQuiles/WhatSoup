import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PRIVATE_TERM_CODES,
  PrivateTermsError,
  expandPrivateTermReplacement,
  loadPrivateTerms,
  privateTermsPath,
  requirePrivateTermsUsable,
  type PrivateTermRule,
} from '../../../scripts/lib/private-terms.ts';
import {
  ABSENT_PRIVATE_TERMS_FILE,
  SYNTHETIC_PRIVATE_TERMS_FILE,
} from '../../helpers/private-terms-env.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('private-terms-');

// Every synthetic id and value in the fixture: no message may ever contain one.
const SYNTHETIC_SECRETS = [
  'M001', 'F001', 'B001', 'C001', 'P001', 'D001', 'A001', 'N001',
  'zorblab', 'zmini', 'qx-bot', 'zqline', 'quorpine', 'corp-zz.example', 'acct-zq-4471', '100.1.2.3',
];

// Home-folder forms are assembled at runtime so this file never carries one literally.
const homeForm = (name: string, rest: string): string => ['', 'Users', name, rest].join('/');

function syntheticRules(): readonly PrivateTermRule[] {
  return requirePrivateTermsUsable(loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE }));
}

function hitCodes(rules: readonly PrivateTermRule[], text: string): string[] {
  return rules.filter((rule) => rule.regex.test(text)).map((rule) => rule.code).sort();
}

function writeTerms(document: unknown): string {
  const file = join(tmp.make('file'), 'private-terms.json');
  writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
  return file;
}

const baseDocument = { schema: 'whatsoup-private-terms', version: 1, contexts: [], terms: [] as unknown[] };

describe('private term file loader', () => {
  it('runs every suite worker against an absent term file with no require switch', () => {
    expect(process.env.WHATSOUP_PRIVATE_TERMS_FILE).toBe(ABSENT_PRIVATE_TERMS_FILE);
    expect(process.env.WHATSOUP_REQUIRE_PRIVATE_TERMS).toBeUndefined();
    expect(loadPrivateTerms(process.env).status).toBe('absent');
  });

  it('resolves the configured path first, then the home default', () => {
    expect(privateTermsPath({ WHATSOUP_PRIVATE_TERMS_FILE: '/x/terms.json', HOME: '/h' })).toBe('/x/terms.json');
    expect(privateTermsPath({ HOME: '/h' })).toBe(join('/h', '.config', 'whatsoup', 'private-terms.json'));
    expect(privateTermsPath({ WHATSOUP_PRIVATE_TERMS_FILE: '', HOME: '/h' }))
      .toBe(join('/h', '.config', 'whatsoup', 'private-terms.json'));
  });

  it('treats an absent file as no rules, and as a failure only under the require switch', () => {
    const absent = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: ABSENT_PRIVATE_TERMS_FILE });
    expect(absent).toMatchObject({ status: 'absent', required: false, sha256: null, rules: [] });
    expect(requirePrivateTermsUsable(absent)).toEqual([]);

    const required = loadPrivateTerms({
      WHATSOUP_PRIVATE_TERMS_FILE: ABSENT_PRIVATE_TERMS_FILE,
      WHATSOUP_REQUIRE_PRIVATE_TERMS: '1',
    });
    expect(required.required).toBe(true);
    let thrown: unknown;
    try {
      requirePrivateTermsUsable(required);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PrivateTermsError);
    expect((thrown as PrivateTermsError).exitCode).toBe(2);
  });

  it('loads the synthetic file, maps classes to codes, and binds the exact file bytes', () => {
    const load = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE });
    expect(load.status).toBe('loaded');
    expect(load.sha256).toBe(createHash('sha256').update(readFileSync(SYNTHETIC_PRIVATE_TERMS_FILE)).digest('hex'));
    expect(load.rules.map((rule) => rule.code)).toEqual([
      'private-host-label',
      'private-host-label',
      'private-instance-label',
      'private-instance-label',
      'private-person',
      'private-domain',
      'private-account-id',
      'private-tailnet-ip',
    ]);
    expect([...PRIVATE_TERM_CODES]).toEqual([
      'private-account-id',
      'private-domain',
      'private-host-label',
      'private-instance-label',
      'private-person',
      'private-tailnet-ip',
    ]);
  });

  const host = ['private-host-label'];
  const instance = ['private-instance-label'];
  const none: string[] = [];
  it.each<{ label: string; text: string; codes: string[] }>([
    // word: boundary is any character outside [A-Za-z0-9_]
    { label: 'word hit', text: 'deploy to zorblab now', codes: host },
    { label: 'word hit, case-insensitive, hyphen boundary', text: 'x-ZORBLAB-y', codes: host },
    { label: 'word control, trailing letter', text: 'zorblabs', codes: none },
    { label: 'word control, leading letter', text: 'myzorblab', codes: none },
    { label: 'word control, underscore is a word character', text: 'zorblab_x', codes: none },
    // word with a regex core
    { label: 'regex hit', text: 'ssh zmini7', codes: host },
    { label: 'regex hit, two digits', text: 'ZMINI12 is up', codes: host },
    { label: 'regex control, three digits', text: 'zmini123', codes: none },
    // word with bot variants
    { label: 'variant hit, hyphen', text: 'qx-bot', codes: instance },
    { label: 'variant hit, underscore', text: 'qx_bot', codes: instance },
    { label: 'variant hit, joined, case-insensitive', text: 'QXBOT', codes: instance },
    { label: 'variant control, plural', text: 'qx-bots', codes: none },
    { label: 'variant control, double separator', text: 'qx--bot', codes: none },
    // context: only inside a declared context form; case-sensitive here
    { label: 'context hit, empty suffix', text: 'com.whatsoup.zqline', codes: instance },
    { label: 'context hit, address form', text: 'whatsoup@zqline', codes: instance },
    { label: 'context hit, path form', text: 'instances/zqline/config.json', codes: instance },
    { label: 'context hit, home form', text: homeForm('zqline', 'x'), codes: instance },
    { label: 'context control, no context', text: 'zqline', codes: none },
    { label: 'context control, empty-suffix boundary', text: 'com.whatsoup.zqlines', codes: none },
    { label: 'context control, case-sensitive', text: 'whatsoup@ZQLINE', codes: none },
    { label: 'context control, missing suffix', text: 'instances/zqline', codes: none },
    // person word
    { label: 'person hit', text: 'Quorpine approved it', codes: ['private-person'] },
    { label: 'person control', text: 'quorpines', codes: none },
    // literal: plain substring
    { label: 'literal hit, substring', text: 'mail.corp-zz.example', codes: ['private-domain'] },
    { label: 'literal hit, case-insensitive', text: 'CORP-ZZ.EXAMPLE', codes: ['private-domain'] },
    { label: 'literal control, dot is literal', text: 'corp-zz-example', codes: none },
    { label: 'literal hit, case-sensitive id', text: 'id acct-zq-4471', codes: ['private-account-id'] },
    { label: 'literal control, case-sensitive id', text: 'ACCT-ZQ-4471', codes: none },
    // address: digit and dotted-octet boundaries
    { label: 'address hit', text: 'host 100.1.2.3:22', codes: ['private-tailnet-ip'] },
    { label: 'address hit, sentence end', text: 'ip=100.1.2.3.', codes: ['private-tailnet-ip'] },
    { label: 'address control, longer final octet', text: '100.1.2.34', codes: none },
    { label: 'address control, longer first octet', text: '1100.1.2.3', codes: none },
    { label: 'address control, fifth octet', text: '100.1.2.3.4', codes: none },
  ])('$label', ({ text, codes }) => {
    expect(hitCodes(syntheticRules(), text)).toEqual(codes);
  });

  it('keeps word boundaries around a core with a top-level alternation', () => {
    const file = writeTerms({
      ...baseDocument,
      terms: [{ id: 'X1', class: 'machine', regex: 'zalpha|zbeta', match: 'word', case: 'sensitive', replace: 'h' }],
    });
    const rules = requirePrivateTermsUsable(loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: file }));
    expect(hitCodes(rules, 'zbeta')).toEqual(['private-host-label']);
    expect(hitCodes(rules, 'xzbeta')).toEqual([]);
    expect(hitCodes(rules, 'zalphax')).toEqual([]);
  });

  it('replaces only the term inside a context and expands the first regex group', () => {
    const rules = syntheticRules();
    const context = rules.find((rule) => rule.code === 'private-instance-label' && rule.replace === 'line-a')!;
    const input = 'whatsoup@zqline and instances/zqline/ and zqline';
    const output = input.replace(context.replaceRegex, (span) => expandPrivateTermReplacement(context, span));
    expect(output).toBe('whatsoup@line-a and instances/line-a/ and zqline');

    const numbered = rules.find((rule) => rule.replace === 'host-{1}')!;
    expect('ssh zmini12'.replace(numbered.replaceRegex, (span) => expandPrivateTermReplacement(numbered, span)))
      .toBe('ssh host-12');
  });

  const term = (fields: Record<string, unknown>) => ({ ...baseDocument, terms: [fields] });
  it.each<{ label: string; document: unknown }>([
    { label: 'not JSON, with a term value inside the broken input', document: '{"terms": [zorblab' },
    { label: 'wrong schema', document: { ...baseDocument, schema: 'other' } },
    { label: 'wrong version', document: { ...baseDocument, version: 2 } },
    { label: 'terms not an array', document: { ...baseDocument, terms: 'zorblab' } },
    { label: 'unknown class', document: term({ id: 'M001', class: 'zorblab', value: 'zorblab', match: 'word', case: 'sensitive' }) },
    { label: 'unknown match', document: term({ id: 'M001', class: 'machine', value: 'zorblab', match: 'fuzzy', case: 'sensitive' }) },
    { label: 'bad case', document: term({ id: 'M001', class: 'machine', value: 'zorblab', match: 'word', case: 'upper' }) },
    { label: 'no value or regex', document: term({ id: 'M001', class: 'machine', match: 'word', case: 'sensitive' }) },
    { label: 'regex that does not compile', document: term({ id: 'F001', class: 'machine', regex: 'zmini([0-9]', match: 'word', case: 'sensitive' }) },
    { label: 'context term without contexts', document: term({ id: 'C001', class: 'instance', value: 'zqline', match: 'context', case: 'sensitive' }) },
    { label: 'context form without its marker', document: { ...baseDocument, contexts: ['whatsoup@zqline'] } },
  ])('reports an invalid file ($label) without any term id or value', ({ document }) => {
    const load = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: writeTerms(document) });
    expect(load.status).toBe('invalid');
    expect(load.rules).toEqual([]);
    for (const secret of SYNTHETIC_SECRETS) expect(load.problem ?? '').not.toContain(secret);
    let message = '';
    try {
      requirePrivateTermsUsable(load);
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateTermsError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/private term file is (?:invalid|not valid JSON)/);
    for (const secret of SYNTHETIC_SECRETS) expect(message).not.toContain(secret);
  });

  it('reports an unreadable path as unusable, never as absent', () => {
    const directory = join(tmp.make('dir'), 'private-terms.json');
    mkdirSync(directory);
    const load = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: directory });
    expect(load.status).toBe('unreadable');
    expect(() => requirePrivateTermsUsable(load)).toThrow(PrivateTermsError);
  });

  it('re-reads a changed file instead of reusing rules compiled from older bytes', () => {
    const file = writeTerms({
      ...baseDocument,
      terms: [{ id: 'M001', class: 'machine', value: 'zorblab', match: 'word', case: 'sensitive', replace: 'h' }],
    });
    const first = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: file });
    writeFileSync(file, JSON.stringify({ ...baseDocument, terms: [] }));
    const second = loadPrivateTerms({ WHATSOUP_PRIVATE_TERMS_FILE: file });
    expect(first.rules).toHaveLength(1);
    expect(second.rules).toHaveLength(0);
    expect(second.sha256).not.toBe(first.sha256);
  });
});
