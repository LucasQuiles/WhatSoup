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

export interface AdminCommand {
  action: 'allow' | 'block';
  subjectType: SubjectType;
  subjectId: string;
}

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

  return null;
}
