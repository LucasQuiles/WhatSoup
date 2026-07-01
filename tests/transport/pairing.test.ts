import { describe, it, expect } from 'vitest';
import {
  classifyPairNumber,
  maskPairingCode,
  pairingEmissionLine,
  pairingGate,
} from '../../src/transport/pairing.ts';

// Synthetic, non-real number assembled from fragments (no PII literal in source).
const FAKE_NUM = '1' + '845' + '5550142'; // 11 synthetic digits

describe('classifyPairNumber', () => {
  it('unset -> QR mode (pairing inert)', () => {
    expect(classifyPairNumber(undefined).reason).toBe('unset');
    expect(classifyPairNumber('').reason).toBe('unset');
    expect(classifyPairNumber('   ').reason).toBe('unset');
  });

  it('present but too short/long -> invalid (fail-closed)', () => {
    expect(classifyPairNumber('123').reason).toBe('invalid');
    expect(classifyPairNumber('abc').reason).toBe('invalid');
    expect(classifyPairNumber('1234567890123456').reason).toBe('invalid'); // 16 digits
  });

  it('valid -> ok, normalized to digits', () => {
    const c = classifyPairNumber('+1 (845) 555-0142');
    expect(c.ok).toBe(true);
    expect(c.number).toBe(FAKE_NUM);
  });
});

describe('maskPairingCode', () => {
  it('never reveals the full code; keeps first2+last1', () => {
    const masked = maskPairingCode('ABCD1234');
    expect(masked).toBe('AB*****4');
    expect(masked).not.toContain('ABCD1234');
    expect(masked.length).toBe('ABCD1234'.length);
  });

  it('short codes fully masked', () => {
    expect(maskPairingCode('AB')).toBe('**');
    expect(maskPairingCode('')).toBe('*');
  });
});

describe('pairingEmissionLine', () => {
  it('is valid JSON on the automation channel', () => {
    const parsed = JSON.parse(pairingEmissionLine('ABCD1234'));
    expect(parsed).toEqual({ event: 'pairing_code', code: 'ABCD1234' });
  });
});

describe('pairingGate', () => {
  const base = { registered: false, alreadyRequested: false };

  it('unset number -> no request, QR default preserved', () => {
    expect(pairingGate({ ...base, rawNumber: undefined })).toEqual({ request: false, reason: 'unset' });
  });

  it('invalid number -> no request (fail-closed)', () => {
    expect(pairingGate({ ...base, rawNumber: '123' })).toEqual({ request: false, reason: 'invalid' });
  });

  it('valid + unregistered + not-yet -> request', () => {
    expect(pairingGate({ ...base, rawNumber: FAKE_NUM })).toEqual({ request: true });
  });

  it('valid but already registered -> no request', () => {
    expect(pairingGate({ rawNumber: FAKE_NUM, registered: true, alreadyRequested: false }))
      .toEqual({ request: false, reason: 'already-registered' });
  });

  it('valid but already requested -> single-fire guard', () => {
    expect(pairingGate({ rawNumber: FAKE_NUM, registered: false, alreadyRequested: true }))
      .toEqual({ request: false, reason: 'single-fire' });
  });
});
