import { ACCOUNT_RE } from './account-segment.ts';

/** Derive the only keyring service a Twilio line may select. */
export function twilioAuthTokenServiceForAccount(account: string): string | null {
  return ACCOUNT_RE.test(account) ? `whatsoup-twilio-${account}` : null;
}

/** Prevent a line from selecting another line's or provider's credential. */
export function isTwilioAuthTokenServiceForAccount(
  service: string,
  account: string,
): boolean {
  return twilioAuthTokenServiceForAccount(account) === service;
}
