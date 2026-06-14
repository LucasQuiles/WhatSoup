// ---------------------------------------------------------------------------
//  Scheduled message utility functions (client-side)
// ---------------------------------------------------------------------------
import type { ScheduledMessage } from '../../types.js';
import { statusColorToken } from '../../lib/status-severity.js';
import { capitalize } from '../../lib/text-utils.js';

type ScheduledStatus = ScheduledMessage['status'];

export function statusColor(status: string): string {
  switch (status as ScheduledStatus) {
    case 'pending':    return statusColorToken('warn');
    case 'processing': return 'var(--mode-chat-solid)';
    case 'sent':       return statusColorToken('ok');
    case 'failed':     return statusColorToken('crit');
    case 'cancelled':  return 'var(--text-2)';
    default:           return 'var(--text-2)';
  }
}

export function statusLabel(status: string): string {
  return capitalize(status);
}

export function contentTypeLabel(type: string): string {
  switch (type) {
    case 'text':     return 'Text';
    case 'image':    return 'Image';
    case 'video':    return 'Video';
    case 'audio':    return 'Audio';
    case 'document': return 'Document';
    case 'location': return 'Location';
    case 'contact':  return 'Contact';
    case 'poll':     return 'Poll';
    case 'sticker':  return 'Sticker';
    default:         return type;
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Client-side cron-to-human formatter (browser — cannot import Node modules).
 * Canonical implementation: src/core/cron.ts cronToHuman(). Keep both in sync.
 */
export function cronToHuman(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hr, dom, , dow] = parts;

  // Every N minutes
  if (min.startsWith('*/') && hr === '*' && dom === '*' && dow === '*') {
    const step = min.slice(2);
    return step === '1' ? 'Every minute' : `Every ${step} minutes`;
  }

  // Specific time
  if (hr !== '*' && min !== '*' && !hr.includes(',') && !min.includes(',')) {
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dom === '*' && dow === '*') return `Daily at ${time}`;
    if (dom === '*' && dow !== '*' && !dow.includes(',')) {
      const dayIdx = parseInt(dow, 10);
      if (!isNaN(dayIdx) && dayIdx >= 0 && dayIdx <= 6) return `Weekly on ${DAY_NAMES[dayIdx]} at ${time}`;
    }
    if (dom !== '*' && !dom.includes(',') && dow === '*') return `Monthly on day ${dom} at ${time}`;
  }

  return `Cron: ${expression}`;
}
