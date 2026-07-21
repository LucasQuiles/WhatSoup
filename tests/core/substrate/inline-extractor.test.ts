import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  classifyInlineImperative,
  extractImperativeTarget,
  matchImperative,
  type InlineImperativeRejectionReason,
  type ImperativeVerb,
} from '../../../src/core/substrate/inline-extractor.ts';

interface CorpusRejectedStructure {
  category: string;
  count: number;
  template: string;
  reason: InlineImperativeRejectionReason;
}

interface CorpusAdmittedStructure {
  body: string;
  verb: ImperativeVerb;
  normalizedTarget: string;
}

interface StructureCorpus {
  rejectedTotal: number;
  admittedTotal: number;
  rejected: CorpusRejectedStructure[];
  admitted: CorpusAdmittedStructure[];
}

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/inline-proposal-structure-corpus.json', import.meta.url)),
    'utf8',
  ),
) as StructureCorpus;

describe('inline extractor — typed anchored classifier', () => {
  it.each([
    ['remind me to inspect the synthetic ledger', 'remind', 'inspect the synthetic ledger'],
    ['schedule a synthetic restart at 21:00', 'schedule', 'a synthetic restart at 21:00'],
    ['watch for the synthetic completion token', 'watch', 'the synthetic completion token'],
    ['follow up with the synthetic release owner', 'follow-up', 'with the synthetic release owner'],
    ['make a task: audit synthetic bridge logs', 'task', 'audit synthetic bridge logs'],
    ['track this for one synthetic week', 'track', 'one synthetic week'],
    ['add a bead about synthetic shutdown handling', 'bead', 'synthetic shutdown handling'],
  ] satisfies Array<[string, ImperativeVerb, string]>)('admits every approved verb: %s', (body, verb, target) => {
    expect(classifyInlineImperative(body)).toMatchObject({
      admitted: true,
      verb,
      normalizedTarget: target,
    });
  });

  it.each([
    ['\uFEFF  ＳＣＨＥＤＵＬＥ： synthetic restart', 'schedule', 'synthetic restart', 'SCHEDULE'],
    ['please remind me that synthetic recovery is complete', 'remind', 'synthetic recovery is complete', 'remind me'],
    ['Please, FOLLOW UP\u2028with the synthetic release owner', 'follow-up', 'with the synthetic release owner', 'FOLLOW UP'],
    ['\twatch for synthetic event one\r\nthen synthetic event two', 'watch', 'synthetic event one\nthen synthetic event two', 'watch for'],
  ] satisfies Array<[string, ImperativeVerb, string, string]>)('normalizes a classification copy: %s', (body, verb, target, matchedText) => {
    const original = body;

    expect(classifyInlineImperative(body)).toEqual({
      admitted: true,
      verb,
      normalizedTarget: target,
      matchedText,
    });
    expect(body).toBe(original);
  });

  it.each([
    ['remind me to synthetic action', 'synthetic action'],
    ['schedule for synthetic maintenance', 'synthetic maintenance'],
    ['watch for that synthetic signal', 'synthetic signal'],
    ['follow up about synthetic release', 'synthetic release'],
    ['make a task: synthetic audit', 'synthetic audit'],
  ])('extracts approved separators: %s', (body, target) => {
    expect(classifyInlineImperative(body)).toMatchObject({
      admitted: true,
      normalizedTarget: target,
    });
  });

  it.each([
    ['', 'empty_target'],
    [' \t ', 'empty_target'],
    ['schedule', 'empty_target'],
    ['please, schedule : \t', 'empty_target'],
    ['> schedule synthetic maintenance', 'quoted_or_fenced'],
    ['```text\nschedule synthetic maintenance\n```', 'quoted_or_fenced'],
    ['~~~\nschedule synthetic maintenance\n~~~', 'quoted_or_fenced'],
    ['Forwarded\nschedule synthetic maintenance', 'quoted_or_fenced'],
    ['[Forwarded many times] schedule synthetic maintenance', 'quoted_or_fenced'],
    ['Status: follow up remains required', 'not_anchored'],
    ['The schedule monitor is stable', 'not_anchored'],
    ['We should watch for another synthetic reconnect', 'not_anchored'],
    ['https://synthetic.invalid/schedule/restart', 'not_anchored'],
    ['{"next":"schedule synthetic maintenance"}', 'not_anchored'],
    ['Error: synthetic failure\n  at schedule (synthetic.ts:1:1)', 'not_anchored'],
    ['Release notes: remind me is now documented', 'not_anchored'],
    ['Please review and add a bead later', 'not_anchored'],
    ['ѕchedule synthetic maintenance', 'not_anchored'],
    ['schedulemonitor synthetic maintenance', 'not_anchored'],
    ['please-schedule synthetic maintenance', 'not_anchored'],
  ] satisfies Array<[string, InlineImperativeRejectionReason]>)('rejects with a bounded reason: %s', (body, reason) => {
    const original = body;

    expect(classifyInlineImperative(body)).toEqual({ admitted: false, reason });
    expect(body).toBe(original);
  });

  it('rejects unsupported message types without throwing', () => {
    expect(classifyInlineImperative(null as unknown as string)).toEqual({
      admitted: false,
      reason: 'unsupported_message_type',
    });
  });

  it('rejects lone surrogates without throwing but admits paired emoji', () => {
    expect(classifyInlineImperative('schedule synthetic \ud800 target')).toEqual({
      admitted: false,
      reason: 'invalid_unicode',
    });
    expect(classifyInlineImperative('schedule synthetic 🚦 target')).toMatchObject({
      admitted: true,
      normalizedTarget: 'synthetic 🚦 target',
    });
  });

  it('measures the 8 KiB limit in UTF-8 bytes after normalization', () => {
    const prefix = 'schedule ';
    const exactLimit = prefix + 'x'.repeat(8 * 1024 - Buffer.byteLength(prefix));
    const overLimit = `${exactLimit}x`;
    const multibyteOverLimit = prefix + '🚦'.repeat(2047);
    const normalizedUnderLimit = `schedule ${'Ａ'.repeat(3000)}`;

    expect(Buffer.byteLength(exactLimit)).toBe(8 * 1024);
    expect(classifyInlineImperative(exactLimit)).toMatchObject({ admitted: true });
    expect(classifyInlineImperative(overLimit)).toEqual({ admitted: false, reason: 'oversize' });
    expect(Buffer.byteLength(multibyteOverLimit)).toBeGreaterThan(8 * 1024);
    expect(classifyInlineImperative(multibyteOverLimit)).toEqual({ admitted: false, reason: 'oversize' });
    expect(Buffer.byteLength(normalizedUnderLimit.normalize('NFKC'))).toBeLessThan(8 * 1024);
    expect(classifyInlineImperative(normalizedUnderLimit)).toMatchObject({ admitted: true });
  });

  it('rejects all 733 synthetic false structures and admits four intended structures', () => {
    const rejected = corpus.rejected.flatMap(({ category, count, template, reason }) =>
      Array.from({ length: count }, (_unused, index) => ({
        category,
        body: template.replace('{index}', String(index + 1)),
        reason,
      })),
    );

    expect(rejected).toHaveLength(corpus.rejectedTotal);
    expect(corpus.rejectedTotal).toBe(733);
    for (const entry of rejected) {
      const original = entry.body;
      expect(classifyInlineImperative(entry.body), entry.category).toEqual({
        admitted: false,
        reason: entry.reason,
      });
      expect(entry.body).toBe(original);
    }

    expect(corpus.admitted).toHaveLength(corpus.admittedTotal);
    expect(corpus.admittedTotal).toBe(4);
    for (const entry of corpus.admitted) {
      const original = entry.body;
      expect(classifyInlineImperative(entry.body)).toMatchObject({
        admitted: true,
        verb: entry.verb,
        normalizedTarget: entry.normalizedTarget,
      });
      expect(entry.body).toBe(original);
    }
  });

  it('keeps compatibility wrappers over the classifier', () => {
    expect(matchImperative('Status: schedule synthetic maintenance')).toBeNull();
    expect(matchImperative('please schedule synthetic maintenance')).toMatchObject({
      verb: 'schedule',
      offset: 0,
      matchedText: 'schedule',
    });
    expect(extractImperativeTarget('remind me to inspect the synthetic ledger')).toBe(
      'inspect the synthetic ledger',
    );
    expect(extractImperativeTarget('Status: schedule synthetic maintenance')).toBe(
      'Status: schedule synthetic maintenance',
    );
  });
});
