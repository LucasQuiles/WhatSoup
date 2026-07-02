import { jidPattern } from '../lib/redaction-patterns.ts';

// QR-080: the prior fixed key-name list left compound-snake (AWS_SESSION_TOKEN,
// aws_secret_access_key) and camelCase-glued (sessionToken, bearerToken) secret
// keys UNREDACTED. Mirror the QR-052/QR-079-hardened coverage: an optional run of
// `<alnum>_` segments anchors compound keys, and the camelCase branch
// `<alnum>{1,40}(token|secret|password|passphrase|api_key)` catches glued keys —
// benign tails (`retry_count=`, `patch=v2`, `session_id`) stay untouched.
const SECRETISH_ASSIGNMENT = /\b((?:[A-Za-z0-9]+_)*(?:client[_-]?secret|private[_-]?key|signing[_-]?key|secret[_-]?access[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|passphrase|session|pat|[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)))(\s*[:=]\s*|["']?\s*:\s*["']?)([^\s"',}]+)/gi;
const AUTHORIZATION_BEARER = /\bAuthorization:\s*Bearer\s+[^\s"',}]+/gi;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
// The optional leading path prefix uses a single flat character-class star anchored at a
// path boundary (`~` or `/`) rather than a nested `(?:~|/[^...]+)*` quantifier. The old form
// backtracked exponentially on `/!/!/...`-style input (CodeQL js/redos); this form is linear
// while still redacting the entire path (parent dirs included) so usernames are not leaked.
const CREDENTIAL_PATH = /(?:[~/][^\s"',}]*)?(?:\.config\/secrets\/[^\s"',}]+|\.config\/whatsoup\/[^\s"',}]+|\.local\/share\/whatsoup\/instances\/[^\s"',}]*\/auth(?:\/[^\s"',}]*)?|auth-bond-backups\/[^\s"',}]+|\/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s"',}]+)?))\b/gi;

export function redactAuthCliText(value: unknown): string {
  return String(value ?? '')
    .replace(CREDENTIAL_PATH, '[REDACTED CREDENTIAL PATH]')
    .replace(jidPattern(), '[REDACTED WHATSAPP JID]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .replace(AUTHORIZATION_BEARER, 'Authorization: Bearer [REDACTED]')
    .replace(SECRETISH_ASSIGNMENT, (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`)
    .replace(BEARER_VALUE, 'Bearer [REDACTED]');
}
