import { afterEach, describe, expect, it } from 'vitest';
import { redactBotErrorsText } from '../../src/lib/bot-errors-outbox.ts';

// B1 — safe-shape credential-path redaction (TS mirror of the Python behavior).
// Gated behind BOT_ERRORS_SAFE_SHAPE_CRED_PATH so default output (the bare
// `[REDACTED CREDENTIAL PATH]` marker) and its parity tests stay unchanged.
//
// Issue #2386: buildBotErrorsEvent now confines evidence to bounded metadata,
// so safe-shape is tested directly on the exported redactBotErrorsText (the
// defense-in-depth layer still used for criticalAsset and writefail payloads).

function redactedEvidence(text: string): string {
  return redactBotErrorsText(text);
}

describe('B1 safe-shape credential-path redaction (TS)', () => {
  afterEach(() => {
    delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
  });

  it('default-off keeps the legacy bare marker', () => {
    delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
    const out = redactedEvidence('expected_path=~/.config/whatsoup/fleet-tokens.json');
    expect(out).toContain('[REDACTED CREDENTIAL PATH]');
    expect(out).not.toContain('fleet-tokens.json');
  });

  it('safe-shape preserves the dir category and marks the leaf', () => {
    process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] = '1';
    const out = redactedEvidence('expected_path=~/.config/whatsoup/fleet-tokens.json');
    expect(out).toContain('.config/whatsoup/[REDACTED]');
    expect(out).not.toContain('[REDACTED CREDENTIAL PATH]');
    expect(out).not.toContain('fleet-tokens.json');
  });

  it('safe-shape still fully redacts a real token value', () => {
    process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] = '1';
    const secret = `ghp_${'z'.repeat(30)}`;
    const out = redactedEvidence(`path=~/.config/whatsoup/creds.json secret_value ${secret} here`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED GITHUB TOKEN]');
    expect(out).toContain('.config/whatsoup/[REDACTED]');
  });
});
