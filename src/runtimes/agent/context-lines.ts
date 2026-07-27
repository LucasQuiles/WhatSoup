import { sanitizeProviderPreviewText } from './provider-preview-sanitizer.ts';

export interface ContextLineMessage {
  timestamp: number;
  senderName: string | null;
  senderJid: string;
  content: string | null;
}

/** Format recent chat context; callers control chronological ordering. */
export function formatContextLines(
  messages: ReadonlyArray<ContextLineMessage>,
  redactForBackup: boolean,
): string {
  return messages
    .map((message) => {
      const timestamp = new Date(message.timestamp * 1000).toTimeString().slice(0, 5);
      const content = message.content ?? '[media]';
      const safe = redactForBackup ? sanitizeProviderPreviewText(content) : content;
      return `[${timestamp}] ${message.senderName ?? message.senderJid}: ${safe}`;
    })
    .join('\n');
}
