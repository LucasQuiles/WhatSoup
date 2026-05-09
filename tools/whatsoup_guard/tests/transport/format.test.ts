import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { muteCommand } from '../../src/cli/mute.ts';
import { formatAlert } from '../../src/transport/format.ts';

const FINGERPRINT = '7a2f' + '0'.repeat(60);

describe('formatAlert', () => {
  it('renders all required fields for a critical alert', () => {
    const text = formatAlert({
      eventId: 4811,
      severity: 'crit',
      scopeId: 'scope-a',
      probeId: 'deployment.tunneling',
      domain: 'exposure',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: { 'rule:10000': '127.0.0.1:11434' }, removed: {}, changed: {} },
      actionLabel: 'remediate:APPLIED',
      fingerprint: FINGERPRINT,
    });

    expect(text).toContain('[whatsoup-guard] CRIT scope-a - deployment.tunneling');
    expect(text).toContain('when:    2026-05-08T14:32:11.000Z');
    expect(text).toContain('probe:   deployment.tunneling');
    expect(text).toContain('domain:  exposure');
    expect(text).toContain('action:  remediate:APPLIED');
    expect(text).toContain(`fingerprint: ${FINGERPRINT}`);
    expect(text).toContain('event-id: 4811');
  });

  it('always includes a copy-pasteable generic mute line', () => {
    const text = formatAlert({
      eventId: 1,
      severity: 'high',
      scopeId: 'scope-a',
      probeId: 'probe.change',
      domain: 'change',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: { x: 1 }, removed: {}, changed: {} },
      actionLabel: 'propose_fix:review-policy',
      fingerprint: 'f'.repeat(64),
    });

    expect(text).toMatch(/mute:\s+whatsoup-guard mute --state-dir '<state-dir>' --host 'scope-a' --domain 'change' --duration 1h --reason '<why>'/);
  });

  it('formats a mute hint that runs through the mute CLI after placeholders are filled', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'wg-format-mute-'));
    const text = formatAlert({
      eventId: 1,
      severity: 'high',
      scopeId: 'scope-a',
      probeId: 'probe.change',
      domain: 'change',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: { x: 1 }, removed: {}, changed: {} },
      actionLabel: 'alert',
      fingerprint: 'f'.repeat(64),
    });

    try {
      const args = muteHintArgs(text)
        .map((arg) => arg === '<state-dir>' ? stateDir : arg)
        .map((arg) => arg === '<why>' ? 'operator acknowledged' : arg);
      const output: string[] = [];

      const code = await muteCommand(args, {
        now: () => new Date('2026-05-08T14:32:11.000Z'),
        write: (chunk) => output.push(chunk),
      });

      expect(code).toBe(0);
      expect(output.join('')).toContain('mute id=');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('shell-quotes mute hint scope and domain values', () => {
    const text = formatAlert({
      eventId: 1,
      severity: 'high',
      scopeId: 'scope-a; touch bad',
      probeId: 'probe.change',
      domain: 'change',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: { x: 1 }, removed: {}, changed: {} },
      actionLabel: 'alert',
      fingerprint: 'f'.repeat(64),
    });

    expect(text).toContain("whatsoup-guard mute --state-dir '<state-dir>' --host 'scope-a; touch bad' --domain 'change'");
    expect(text).not.toContain('--host scope-a; touch');
  });

  it('escapes single quotes in mute hint values', () => {
    const text = formatAlert({
      eventId: 1,
      severity: 'high',
      scopeId: "scope-'quoted'",
      probeId: 'probe.change',
      domain: 'change',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: { x: 1 }, removed: {}, changed: {} },
      actionLabel: 'alert',
      fingerprint: 'f'.repeat(64),
    });

    expect(text).toContain(`--host 'scope-'"'"'quoted'"'"''`);
  });

  it('formats low severity without changing the severity input', () => {
    const severity = 'low';
    const text = formatAlert({
      eventId: 2,
      severity,
      scopeId: 'scope-b',
      probeId: 'probe.low',
      domain: 'capability',
      ts: '2026-05-08T14:32:11.000Z',
      diff: { added: {}, removed: {}, changed: { role: { from: 'a', to: 'b' } } },
      actionLabel: 'alert',
      fingerprint: 'a'.repeat(64),
    });

    expect(severity).toBe('low');
    expect(text.startsWith('[whatsoup-guard] LOW scope-b - probe.low')).toBe(true);
  });

  it('keeps diff output valid JSON and does not mutate input diff', () => {
    const diff = { added: { x: 1 }, removed: {}, changed: {} };
    const text = formatAlert({
      eventId: 3,
      severity: 'med',
      scopeId: 'scope-c',
      probeId: 'probe.diff',
      domain: 'credential',
      ts: '2026-05-08T14:32:11.000Z',
      diff,
      actionLabel: 'alert',
      fingerprint: 'b'.repeat(64),
    });

    const diffLine = text.split('\n').find((line) => line.startsWith('diff:    '));
    expect(diffLine).toBeDefined();
    expect(JSON.parse(diffLine!.replace('diff:    ', ''))).toEqual(diff);
    expect(diff).toEqual({ added: { x: 1 }, removed: {}, changed: {} });
  });
});

function muteHintArgs(text: string): string[] {
  const line = text.split('\n').find((candidate) => candidate.startsWith('mute: '));
  if (!line) throw new Error('mute line missing');
  return shellSplit(line.replace('mute: whatsoup-guard mute ', ''));
}

function shellSplit(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === "'") {
      quoted = !quoted;
      continue;
    }
    if (char === ' ' && !quoted) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) out.push(current);
  return out;
}
