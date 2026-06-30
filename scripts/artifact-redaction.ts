const SECRET_LIKE_RE = /\b(?:Bearer\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9._-]{12,}|[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*['"]?[A-Za-z0-9._/-]{8,}|120363\d{8,}@g\.us|\d{8,}@(s\.whatsapp\.net|lid))\b/i;

export function assertNoSecretLike(text: string, label: string): void {
  if (SECRET_LIKE_RE.test(text)) {
    throw new Error(`redaction_violation: ${label} must not contain secret-like values`);
  }
}
