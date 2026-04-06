// ---------------------------------------------------------------------------
//  Scheduled message utility functions (client-side)
// ---------------------------------------------------------------------------

export function statusColor(status: string): string {
  switch (status) {
    case 'pending':    return 'var(--color-warning, #f59e0b)';
    case 'processing': return 'var(--color-info, #3b82f6)';
    case 'sent':       return 'var(--color-success, #22c55e)';
    case 'failed':     return 'var(--color-error, #ef4444)';
    case 'cancelled':  return 'var(--color-muted, #6b7280)';
    default:           return 'var(--color-muted, #6b7280)';
  }
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
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

export function cronToHuman(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hr, dom, , dow] = parts;

  // Every N minutes
  if (min.startsWith('*/') && hr === '*' && dom === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
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
