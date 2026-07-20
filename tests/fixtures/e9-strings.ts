// Shared E9 fixture strings (packet D5). The canonical "bare '@' used as the
// word 'at'" message is pinned by BOTH the provider-preview sanitizer suite
// (tests/runtimes/agent/providers/api-preview-redaction.test.ts) and the
// outbound-message-safety suite (tests/core/outbound-message-safety.test.ts)
// — one exported constant so the two suites can never drift apart on the
// exact protected text (B25 3d).
export const E9_BARE_AT_MESSAGE = 'meet @ 5pm to review the deck';
