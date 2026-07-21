import { config } from '../config.ts';
import type { IncomingMessage } from './types.ts';
import type { Database } from './database.ts';
import { resolvePhoneFromJid } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { isAdminPhone, isE164Wire } from '../lib/phone.ts';
import { isAuthenticatedSenderJid } from './jid-constants.ts';
import { SIGNAL_UUID_RE } from './transport-refs.ts';

export function isAdminMessage(msg: IncomingMessage, db: Database): boolean {
  // Only an authenticated sender namespace may carry an admin identity. SMS
  // resolves to the same bare phone as a configured admin but remains spoofable;
  // Signal and iMessage identities are protocol-authenticated and exact-matched.
  if (!isAuthenticatedSenderJid(msg.senderJid)) return false;
  const phone = resolvePhoneFromJid(msg.senderJid, db);
  return isAdminPhone(phone, config.adminPhones) && msg.isGroup === false;
}

export type AdminCommand =
  | { action: 'allow' | 'block'; subjectType: SubjectType; subjectId: string }
  | { action: 'fallback'; sub: 'on'; durationMs?: number }
  | { action: 'fallback'; sub: 'off' | 'status' | 'help' }
  | { action: 'grant'; sub: 'arm'; group: string; durationMs?: number }
  | { action: 'grant'; sub: 'disarm' | 'status' | 'help' };

export function parseAdminCommand(content: string): AdminCommand | null {
  // ALLOW GROUP <jid> / BLOCK GROUP <jid>
  const groupMatch = content.match(/^(allow|block)\s+group\s+(\S+)\s*$/i);
  if (groupMatch) {
    return {
      action: groupMatch[1].toLowerCase() as 'allow' | 'block',
      subjectType: 'group',
      subjectId: groupMatch[2],
    };
  }

  // ALLOW <identity> / BLOCK <identity>. WhatsApp/Twilio use digit-only
  // subjects; Signal preserves canonical +E.164 or UUID subjects because its
  // access-list keys are protocol identities rather than normalized digits.
  const phoneMatch = content.match(/^(allow|block)\s+(\S+)\s*$/i);
  const rawSubject = phoneMatch?.[2];
  const canonicalSubject = rawSubject !== undefined && SIGNAL_UUID_RE.test(rawSubject.toLowerCase())
    ? rawSubject.toLowerCase()
    : rawSubject;
  if (
    phoneMatch
    && canonicalSubject !== undefined
    && (/^\d+$/.test(canonicalSubject) || isE164Wire(canonicalSubject) || SIGNAL_UUID_RE.test(canonicalSubject))
  ) {
    return {
      action: phoneMatch[1].toLowerCase() as 'allow' | 'block',
      subjectType: 'phone',
      subjectId: canonicalSubject,
    };
  }

  // FALLBACK ON [<n>m|<n>h] — n must be a positive integer; 0m/0h/garbage → null
  const fallbackOn = content.match(/^fallback\s+on(?:\s+([1-9]\d*)\s*([mh]))?\s*$/i);
  if (fallbackOn) {
    const n = fallbackOn[1] ? Number(fallbackOn[1]) : undefined;
    const unit = fallbackOn[2]?.toLowerCase();
    return { action: 'fallback', sub: 'on', ...(n !== undefined ? { durationMs: n * (unit === 'h' ? 3_600_000 : 60_000) } : {}) };
  }

  // FALLBACK OFF / FALLBACK STATUS / FALLBACK HELP
  const fallbackCtl = content.match(/^fallback\s+(off|status|help)\s*$/i);
  if (fallbackCtl) return { action: 'fallback', sub: fallbackCtl[1].toLowerCase() as 'off' | 'status' | 'help' };

  // Bare FALLBACK or FALLBACK HELP (no sub-command) → help
  if (content.match(/^fallback\s*$/i)) return { action: 'fallback', sub: 'help' };

  // GRANT DISARM / GRANT STATUS / GRANT HELP — reserved sub-commands, matched
  // BEFORE the group wildcard so a literal "grant disarm" is control, not an
  // attempt to arm a group named "disarm".
  const grantCtl = content.match(/^grant\s+(disarm|status|help)\s*$/i);
  if (grantCtl) return { action: 'grant', sub: grantCtl[1].toLowerCase() as 'disarm' | 'status' | 'help' };

  // GRANT <group> [<n>m|<n>h] — arm a capability grant for an optional duration.
  // n must be a positive integer; 0m/0h/garbage falls through to null.
  const grantArm = content.match(/^grant\s+([a-z0-9_-]+)(?:\s+([1-9]\d*)\s*([mh]))?\s*$/i);
  if (grantArm) {
    const n = grantArm[2] ? Number(grantArm[2]) : undefined;
    const unit = grantArm[3]?.toLowerCase();
    return {
      action: 'grant',
      sub: 'arm',
      group: grantArm[1].toLowerCase(),
      ...(n !== undefined ? { durationMs: n * (unit === 'h' ? 3_600_000 : 60_000) } : {}),
    };
  }

  // Bare GRANT (no sub-command) → help
  if (content.match(/^grant\s*$/i)) return { action: 'grant', sub: 'help' };

  return null;
}
