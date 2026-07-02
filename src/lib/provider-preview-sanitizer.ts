// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

export function sanitizeProviderPreviewText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      // QR-079: a fixed key-name denylist leaked compound-snake (AWS_SESSION_TOKEN,
      // aws_secret_access_key) and camelCase-glued (sessionToken, bearerToken) secret
      // keys across every consumer of this SSOT sanitizer (handoff corpus → third-party
      // summarizer, outbound-message-safety, provider logs, backups). Mirror the
      // QR-052-hardened bot-errors KEYED_SECRET_RE coverage: an optional run of
      // `<alnum>_` segments anchors compound keys, and the camelCase branch
      // `<alnum>{1,40}(token|secret|password|passphrase|api_key)` catches glued keys —
      // while benign tails (`retry_count=`, `event_count=`) stay untouched.
      /\b((?:[A-Za-z0-9]+_)*(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20}|client[_-]?secret|private[_-]?key|signing[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|cookie|credential|password|passphrase|secret|session|token|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)|pat)\s*[:=]\s*['"]?)[^'"\s]{8,}/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)[-_A-Za-z0-9]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
