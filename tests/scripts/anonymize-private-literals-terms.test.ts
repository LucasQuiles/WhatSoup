import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { anonymizeText, main } from '../../scripts/anonymize-private-literals.ts';
import { compilePrivateTerms, loadPrivateTerms, requirePrivateTermsUsable } from '../../scripts/lib/private-terms.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';
import { SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('anonymizer-terms-');

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

describe('anonymizer selection, caching, re-emission and report', () => {
  const doc = (terms: unknown[]) => compilePrivateTerms({ schema: 'whatsoup-private-terms', version: 1, terms });
  // Home-folder forms are assembled at runtime so this file never carries one literally.
  const homeForm = (name: string, rest: string): string => ['', 'Users', name, rest].join('/');

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('lets the longest match win across terms, then the earlier start, whatever the term order', () => {
    const terms = doc([
      { id: 'S001', class: 'machine', value: 'zq-alpha', match: 'word', case: 'sensitive', replace: 'short-a' },
      { id: 'L001', class: 'machine', value: 'zq-alpha-beta', match: 'literal', case: 'sensitive', replace: 'long-a' },
      { id: 'E001', class: 'machine', value: 'aazz', match: 'literal', case: 'sensitive', replace: 'left-a' },
      { id: 'E002', class: 'machine', value: 'zzbb', match: 'literal', case: 'sensitive', replace: 'right-a' },
    ]);
    expect(anonymizeText('see zq-alpha-beta and aazzbb', terms).text).toBe('see long-a and left-abb');
  });

  it('lets a context term claim its context, so it wins over the generic home-path rewrite', () => {
    expect(anonymizeText(`cd ${homeForm('zqline', 'notes')}`, rules()).text).toBe(`cd ${homeForm('line-a', 'notes')}`);
    expect(anonymizeText(`cd ${homeForm('zzother', 'notes')}`, rules()).text).toBe('cd /home/whatsoup/notes');
  });

  it('keys the cache on the term, so one value with two replacements keeps both', () => {
    const terms = doc([
      { id: 'I001', class: 'instance', value: 'zqline', match: 'context', case: 'sensitive', contexts: ['a/{t}/'], replace: 'bot-a' },
      { id: 'I002', class: 'instance', value: 'zqline', match: 'context', case: 'sensitive', contexts: ['b/{t}/'], replace: 'bot-b' },
    ]);
    const result = anonymizeText('a/zqline/ b/zqline/', terms);
    expect(result.text).toBe('a/bot-a/ b/bot-b/');
    expect(result.replacements.map((replacement) => [replacement.term, replacement.count])).toEqual([['I001', 1], ['I002', 1]]);
  });

  it('never re-emits the matched value through {N}, nor puts a term back beside a replacement', () => {
    const whole = doc([{ id: 'G001', class: 'machine', regex: '(zorblab)', match: 'word', case: 'sensitive', replace: '{1}' }]);
    expect(anonymizeText('ssh zorblab', whole)).toEqual({
      text: 'ssh zorblab',
      replacements: [],
      refused: [{ code: 'private-host-label', count: 1, reason: 'would-re-emit-term' }],
    });
    const parts = doc([{ id: 'G002', class: 'machine', regex: '(zorb)(lab)', match: 'word', case: 'sensitive', replace: '{1}-{2}' }]);
    expect(anonymizeText('ssh zorblab', parts).text).toBe('ssh zorblab');
    const joined = doc([
      { id: 'H001', class: 'machine', value: 'zqhead', match: 'literal', case: 'sensitive', replace: 'zq' },
      { id: 'H002', class: 'machine', value: 'zqtail', match: 'literal', case: 'sensitive', replace: 'tail-a' },
    ]);
    expect(anonymizeText('zqheadtail', joined)).toEqual({
      text: 'zqheadtail',
      replacements: [],
      refused: [{ code: 'term-guard', count: 1, reason: 'would-re-emit-term' }],
    });
  });

  it('reports counts per term id without replacement text, writes only files without a refusal, names a bad argument by position', () => {
    vi.stubEnv('WHATSOUP_PRIVATE_TERMS_FILE', SYNTHETIC_PRIVATE_TERMS_FILE);
    const repo = tmp.make('repo');
    execFileSync('git', ['init', '--quiet'], { cwd: repo, env: isolatedGitEnv(), stdio: 'ignore' });
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes', 'zorblab.md'), 'ssh zorblab\n');
    writeFileSync(join(repo, 'notes', 'ping.md'), `ping ${['@', 'zorblab'].join('')} then ssh zorblab\n`);
    execFileSync('git', ['add', 'notes'], { cwd: repo, env: isolatedGitEnv(), stdio: 'ignore' });
    const runMain = (argv: string[]): { output: string; exitCode: number } => {
      const lines: string[] = [];
      const record = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };
      vi.spyOn(console, 'log').mockImplementation(record);
      vi.spyOn(console, 'error').mockImplementation(record);
      const exitCode = main(argv, repo);
      vi.restoreAllMocks();
      return { output: lines.join('\n'), exitCode };
    };

    const report = runMain(['--json', 'notes']);
    expect(report.exitCode).toBe(1);
    const parsed = JSON.parse(report.output) as { changes: Array<{ filePath: string; replacements: unknown[] }> };
    expect(parsed.changes.map((change) => change.filePath)).toEqual(['notes/ping.md', 'notes/<private>.md']);
    expect(parsed.changes[1]!.replacements).toEqual([{ term: 'M001', count: 1 }]);
    expect(report.output).not.toContain('host-a');
    expect(report.output.toLowerCase()).not.toContain('zorblab');

    expect(runMain(['--write', 'notes']).exitCode).toBe(1);
    expect(readFileSync(join(repo, 'notes', 'zorblab.md'), 'utf8')).toBe('ssh host-a\n');
    expect(readFileSync(join(repo, 'notes', 'ping.md'), 'utf8')).toContain('then ssh zorblab');

    const usage = runMain(['--zorblab-flag']);
    expect(usage.exitCode).toBe(2);
    expect(usage.output).toContain('position 1');
    expect(usage.output).not.toContain('zorblab');
  });

  it('refuses a term file whose id holds a term value, so the JSON report never prints it', () => {
    const termsFile = join(tmp.make('id-terms'), 'private-terms.json');
    writeFileSync(termsFile, JSON.stringify({
      schema: 'whatsoup-private-terms',
      version: 1,
      terms: [{ id: 'zorblab', class: 'machine', value: 'zorblab', match: 'word', case: 'sensitive', replace: 'host-a' }],
    }));
    vi.stubEnv('WHATSOUP_PRIVATE_TERMS_FILE', termsFile);
    const repo = tmp.make('id-repo');
    execFileSync('git', ['init', '--quiet'], { cwd: repo, env: isolatedGitEnv(), stdio: 'ignore' });
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes', 'host.md'), 'ssh zorblab\n');
    execFileSync('git', ['add', 'notes'], { cwd: repo, env: isolatedGitEnv(), stdio: 'ignore' });
    const lines: string[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    const exitCode = main(['--json', 'notes'], repo);
    vi.restoreAllMocks();

    expect(exitCode).toBe(2);
    expect(lines).toEqual([
      'private term file is invalid (the file named by WHATSOUP_PRIVATE_TERMS_FILE): terms[0]: id holds the private term of terms[0]',
    ]);
    expect(readFileSync(join(repo, 'notes', 'host.md'), 'utf8')).toBe('ssh zorblab\n');
  });
});
