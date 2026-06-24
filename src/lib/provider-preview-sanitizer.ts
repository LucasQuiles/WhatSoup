// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

export function sanitizeProviderPreviewText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|pat|password|secret)\s*[:=]\s*['"]?)[^'"\s]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
