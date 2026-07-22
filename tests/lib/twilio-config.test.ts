import { describe, expect, it } from 'vitest';
import {
  isTwilioAuthTokenServiceForAccount,
  twilioAuthTokenServiceForAccount,
} from '../../src/lib/twilio-config.ts';

describe('Twilio credential selector binding', () => {
  it('derives exactly one provider-owned service from the immutable account', () => {
    expect(twilioAuthTokenServiceForAccount('sms-agent')).toBe('whatsoup-twilio-sms-agent');
    expect(twilioAuthTokenServiceForAccount('UPPER')).toBeNull();
    expect(twilioAuthTokenServiceForAccount('../escape')).toBeNull();
  });

  it.each([
    'whatsoup-twilio-other-line',
    'whatsoup-twilio',
    'twilio-sms-agent',
    'openai',
    'whatsoup-health-token',
  ])('rejects a cross-line or cross-provider selector %s', (service) => {
    expect(isTwilioAuthTokenServiceForAccount(service, 'sms-agent')).toBe(false);
  });

  it('accepts only the exact same-line selector', () => {
    expect(isTwilioAuthTokenServiceForAccount('whatsoup-twilio-sms-agent', 'sms-agent')).toBe(true);
  });
});
