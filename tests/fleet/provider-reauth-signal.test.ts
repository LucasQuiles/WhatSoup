import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyProviderReauthSignal, providerReauthClearProof } from '../../src/fleet/provider-reauth-signal.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'health', name), 'utf8'));

describe('classifyProviderReauthSignal', () => {
  it('confirms the incident fixture (boolean-first path) with redacted evidence', () => {
    const sig = classifyProviderReauthSignal(fixture('provider-reauth-required.json'));
    expect(sig.confirmed).toBe(true);
    expect(sig.evidence.join(' ')).toContain('model_usability_status=credential-unavailable');
  });

  it('does NOT confirm the recovery-window fixture', () => {
    expect(classifyProviderReauthSignal(fixture('provider-reauth-recovered.json')).confirmed).toBe(false);
  });

  it('mixed-fleet: derives from turn_capability enums when the boolean is absent (older instances)', () => {
    const body = fixture('provider-reauth-required.json');
    delete body['reauth_required'];
    expect(classifyProviderReauthSignal(body).confirmed).toBe(true);
    const recovered = fixture('provider-reauth-recovered.json');
    delete recovered['reauth_required'];
    expect(classifyProviderReauthSignal(recovered).confirmed).toBe(false); // decision-8 supersession in the fallback too
  });

  it('malformed/missing turn_capability and no boolean → NOT confirmed (never a reauth page, ALERT-14)', () => {
    expect(classifyProviderReauthSignal({ status: 'degraded' }).confirmed).toBe(false);
    expect(classifyProviderReauthSignal({ status: 'degraded', turn_capability: 'garbage' }).confirmed).toBe(false);
    expect(classifyProviderReauthSignal({ status: 'degraded', turn_capability: null }).confirmed).toBe(false);
  });

  it('the boolean wins when present, even over odd enum residue', () => {
    const body = fixture('provider-reauth-recovered.json');
    (body as Record<string, unknown>)['reauth_required'] = false;
    expect(classifyProviderReauthSignal(body).confirmed).toBe(false);
  });
});

describe('providerReauthClearProof', () => {
  it('recovery-window fixture proves the clear', () => {
    expect(providerReauthClearProof(fixture('provider-reauth-recovered.json'))).toBe(true);
  });
  it('incident fixture does not', () => {
    expect(providerReauthClearProof(fixture('provider-reauth-required.json'))).toBe(false);
  });
  it('stale usable does not prove the clear', () => {
    const body = fixture('provider-reauth-recovered.json');
    (body['turn_capability'] as Record<string, unknown>)['model_usable_stale'] = true;
    expect(providerReauthClearProof(body)).toBe(false);
  });
  it('missing turn_capability never proves the clear', () => {
    expect(providerReauthClearProof({ status: 'healthy', reauth_required: false })).toBe(false);
  });
});
