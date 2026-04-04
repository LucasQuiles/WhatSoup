import type { TurnPart, ImageSupport } from './types.ts';

/**
 * Encode media parts for a specific provider's image support mode.
 * Converts canonical TurnPart[] into provider-specific format.
 */
export function encodeMediaForProvider(
  parts: TurnPart[],
  imageSupport: ImageSupport,
): { textParts: string[]; mediaFlags: string[]; base64Parts: Array<{ mimeType: string; data: string }>; pendingFiles: Array<{ mimeType: string; filePath: string }> } {
  const textParts: string[] = [];
  const mediaFlags: string[] = [];
  const base64Parts: Array<{ mimeType: string; data: string }> = [];
  const pendingFiles: Array<{ mimeType: string; filePath: string }> = [];

  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        textParts.push(part.text);
        break;

      case 'image':
        switch (imageSupport) {
          case 'file_path':
            // Claude: inline file path reference
            textParts.push(part.caption ? `[Image: ${part.filePath}] ${part.caption}` : `[Image: ${part.filePath}]`);
            break;
          case 'startup_only':
            // Codex: can only pass images at spawn time via --image flag
            if (part.filePath) mediaFlags.push('--image', part.filePath);
            else textParts.push('[Image received but cannot be displayed mid-conversation]');
            break;
          case 'base64':
            // API providers: base64 encoded
            if (part.base64) {
              base64Parts.push({ mimeType: part.mimeType, data: part.base64 });
            } else if (part.filePath) {
              // File needs base64 encoding — caller must handle this
              // by reading the file and re-encoding before sending to the API
              pendingFiles.push({ mimeType: part.mimeType, filePath: part.filePath });
            }
            if (part.caption) textParts.push(part.caption);
            break;
          case 'native':
            // Provider handles natively — pass through
            if (part.filePath) textParts.push(`@${part.filePath}`);
            break;
          case 'none':
            textParts.push('[Image received but this provider does not support images]');
            break;
        }
        break;

      case 'audio':
        // Audio is always transcribed before reaching the provider
        if (part.transcript) {
          textParts.push(`[Audio transcript]: ${part.transcript}`);
        } else if (part.filePath) {
          textParts.push(`[Audio file: ${part.filePath}]`);
        }
        break;

      case 'document':
        if (part.extractedText) {
          textParts.push(`[Document: ${part.filename ?? 'file'}]\n${part.extractedText}`);
        } else if (part.filePath) {
          textParts.push(`[Document: ${part.filePath}]`);
        }
        break;
    }
  }

  return { textParts, mediaFlags, base64Parts, pendingFiles };
}

/**
 * Convert TurnParts to a simple text string for CLI providers.
 * Handles image/audio/document encoding per provider's image support mode.
 */
export function turnPartsToText(parts: TurnPart[], imageSupport: ImageSupport): string {
  const { textParts } = encodeMediaForProvider(parts, imageSupport);
  return textParts.join('\n');
}

/**
 * Convert TurnParts to OpenAI message content array format.
 * Supports text + image_url content parts.
 */
export function turnPartsToOpenAIContent(
  parts: TurnPart[],
): Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];

  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        content.push({ type: 'text', text: part.text });
        break;
      case 'image':
        if (part.base64) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${part.mimeType};base64,${part.base64}` },
          });
        }
        if (part.caption) content.push({ type: 'text', text: part.caption });
        break;
      case 'audio':
        if (part.transcript) content.push({ type: 'text', text: `[Audio]: ${part.transcript}` });
        break;
      case 'document':
        if (part.extractedText) content.push({ type: 'text', text: `[${part.filename ?? 'Document'}]:\n${part.extractedText}` });
        break;
    }
  }

  return content.length > 0 ? content : [{ type: 'text', text: '' }];
}
