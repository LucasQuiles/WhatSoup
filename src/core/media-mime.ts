/** Baileys message key for each content type. */
const RAW_MSG_KEY: Record<string, string> = {
  image: 'imageMessage',
  audio: 'audioMessage',
  video: 'videoMessage',
  document: 'documentMessage',
};

/**
 * Extract the MIME type from a raw Baileys message for a given content type.
 * Returns undefined when the MIME cannot be determined from the raw message.
 */
export function extractRawMime(rawMessage: unknown, contentType: string): string | undefined {
  if (!rawMessage) return undefined;
  const raw = rawMessage as any;
  const key = RAW_MSG_KEY[contentType];
  if (!key) return undefined;
  let msgNode = raw?.message?.[key];
  // documentWithCaptionMessage wraps the real documentMessage one level deeper
  if (contentType === 'document' && !msgNode) {
    msgNode = raw?.message?.documentWithCaptionMessage?.message?.documentMessage;
  }
  return msgNode?.mimetype as string | undefined;
}
