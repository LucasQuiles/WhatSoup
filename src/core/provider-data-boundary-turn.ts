import type {
  ProviderBoundaryTurnPart,
  ProviderDataBoundary,
} from './provider-data-boundary-contract.ts';

/** Atomically transform every local text field in one provider turn. */
export function exposeProviderTurnParts(
  boundary: ProviderDataBoundary | undefined,
  parts: readonly ProviderBoundaryTurnPart[],
): ProviderBoundaryTurnPart[] {
  if (!boundary) return [...parts];
  const texts: string[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case 'text':
        texts.push(part.text);
        break;
      case 'image':
        if (part.filePath) texts.push(part.filePath);
        if (part.caption) texts.push(part.caption);
        break;
      case 'audio':
        if (part.filePath) texts.push(part.filePath);
        if (part.transcript) texts.push(part.transcript);
        break;
      case 'document':
        texts.push(part.filePath);
        if (part.extractedText) texts.push(part.extractedText);
        if (part.filename) texts.push(part.filename);
        break;
    }
  }
  const exposed = boundary.exposeTexts(texts, { surface: 'turn' });
  let index = 0;
  const next = (): string => exposed[index++]!;
  return parts.map((part) => {
    switch (part.kind) {
      case 'text':
        return { ...part, text: next() };
      case 'image':
        return {
          ...part,
          ...(part.filePath ? { filePath: next() } : {}),
          ...(part.caption ? { caption: next() } : {}),
        };
      case 'audio':
        return {
          ...part,
          ...(part.filePath ? { filePath: next() } : {}),
          ...(part.transcript ? { transcript: next() } : {}),
        };
      case 'document':
        return {
          ...part,
          filePath: next(),
          ...(part.extractedText ? { extractedText: next() } : {}),
          ...(part.filename ? { filename: next() } : {}),
        };
    }
  });
}
