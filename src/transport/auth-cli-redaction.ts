const SECRETISH_ASSIGNMENT = /\b(token|secret|api[_-]?key|password|passwd|pat|private[_-]?key|client[_-]?secret)(\s*[:=]\s*|["']?\s*:\s*["']?)([^\s"',}]+)/gi;
const AUTHORIZATION_BEARER = /\bAuthorization:\s*Bearer\s+[^\s"',}]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const WHATSAPP_JID = /\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid)\b/gi;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const CREDENTIAL_PATH = /(?:~|\/[^\s"',}]+)*(?:\.config\/whatsoup\/[^\s"',}]+|\.local\/share\/whatsoup\/instances\/[^\s"',}]*\/auth(?:\/[^\s"',}]*)?|auth-bond-backups\/[^\s"',}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env))\b/gi;

export function redactAuthCliText(value: unknown): string {
  return String(value ?? '')
    .replace(CREDENTIAL_PATH, '[REDACTED CREDENTIAL PATH]')
    .replace(WHATSAPP_JID, '[REDACTED WHATSAPP JID]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AUTHORIZATION_BEARER, 'Authorization: Bearer [REDACTED]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]');
}
