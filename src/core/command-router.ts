import { config } from '../config.ts';
import type { IncomingMessage } from './types.ts';
import type { Database } from './database.ts';
import { resolvePhoneFromJid } from './access-list.ts';
import type { SubjectType } from './access-list.ts';
import { isAdminPhone } from '../lib/phone.ts';

export function isAdminMessage(msg: IncomingMessage, db: Database): boolean {
  const phone = resolvePhoneFromJid(msg.senderJid, db);
  return isAdminPhone(phone, config.adminPhones) && msg.isGroup === false;
}

export type AdminCommand =
  | { action: 'allow' | 'block'; subjectType: SubjectType; subjectId: string }
  | { action: 'fallback'; sub: 'on'; durationMs?: number }
  | { action: 'fallback'; sub: 'off' | 'status' };

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

  // ALLOW <phone> / BLOCK <phone>
  const phoneMatch = content.match(/^(allow|block)\s+(\d+)\s*$/i);
  if (phoneMatch) {
    return {
      action: phoneMatch[1].toLowerCase() as 'allow' | 'block',
      subjectType: 'phone',
      subjectId: phoneMatch[2],
    };
  }

  // FALLBACK ON [<n>m|<n>h] — n must be a positive integer; 0m/0h/garbage → null
  const fallbackOn = content.match(/^fallback\s+on(?:\s+([1-9]\d*)\s*([mh]))?\s*$/i);
  if (fallbackOn) {
    const n = fallbackOn[1] ? Number(fallbackOn[1]) : undefined;
    const unit = fallbackOn[2]?.toLowerCase();
    return { action: 'fallback', sub: 'on', ...(n !== undefined ? { durationMs: n * (unit === 'h' ? 3_600_000 : 60_000) } : {}) };
  }

  // FALLBACK OFF / FALLBACK STATUS
  const fallbackCtl = content.match(/^fallback\s+(off|status)\s*$/i);
  if (fallbackCtl) return { action: 'fallback', sub: fallbackCtl[1].toLowerCase() as 'off' | 'status' };

  return null;
}
