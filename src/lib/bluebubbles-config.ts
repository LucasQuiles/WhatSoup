import { ACCOUNT_RE } from './account-segment.ts';

const BLUEBUBBLES_PASSWORD_SERVICE_RE = /^whatsoup-bluebubbles(?:-[a-z0-9][a-z0-9-]{0,63})?$/;

/** Restrict BlueBubbles lookups to a provider-owned keyring namespace. */
export function isBluebubblesPasswordService(service: string): boolean {
  return BLUEBUBBLES_PASSWORD_SERVICE_RE.test(service);
}

export function bluebubblesPasswordServiceForAccount(account: string): string | null {
  return ACCOUNT_RE.test(account) ? `whatsoup-bluebubbles-${account}` : null;
}

/** Prevent one line from selecting another line's BlueBubbles credential. */
export function isBluebubblesPasswordServiceForAccount(service: string, account: string): boolean {
  return bluebubblesPasswordServiceForAccount(account) === service;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some(part => part === '' || !Number.isInteger(Number(part)))) return false;
  const octets = parts.map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127;
}

/** HTTPS is mandatory unless the BlueBubbles server is on loopback. */
export function isTrustedBluebubblesUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
