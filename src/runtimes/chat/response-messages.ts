/**
 * Deterministic, occurrence-fitting user-facing messages for chat-runtime
 * failures (#1064).
 *
 * Mirrors the agent runtime's user-message SSOT
 * (`src/runtimes/agent/response-templates.ts`), which maps an explicit failure
 * taxonomy to byte-stable copy. The chat runtime has far fewer states, so this
 * stays deliberately small and flat rather than reusing the agent's 18-class
 * registry. Pure data + a render function — no wall-clock, snapshot-testable.
 *
 * Before this, the chat runtime collapsed every failure AND a valid empty
 * completion into one generic string ("lol my brain just broke"). Each cause
 * below is a distinct occurrence the runtime can already tell apart from the
 * thrown `WhatSoupError.code`.
 *
 * NOTE: a *valid empty completion* is intentionally NOT represented here. When
 * the model returns successfully with no text it chose to stay silent, so the
 * runtime sends nothing — it is not a failure and must not emit a failure
 * message.
 */
export type ChatFailureCause =
  | 'auth' // provider auth/config error — non-retryable; operator already alerted
  | 'rate-limited' // provider rate limit — retry shortly
  | 'transient' // bad request / single-provider hiccup — retry or rephrase
  | 'outage'; // every provider failed — retry shortly; operator already alerted

const CHAT_FAILURE_MESSAGES: Record<ChatFailureCause, string> = {
  auth: "⚠️ I can't reach my language model right now — it looks like a setup issue on my end. My operator has been notified; please try again later.",
  'rate-limited': "I'm getting more messages than I can keep up with right now — give me a minute and ask again.",
  transient: 'lol my brain glitched for a sec — mind asking me again?',
  outage: "⚠️ My language model is unavailable right now and my operator has been notified — please try again in a bit.",
};

/** Render the deterministic user-facing message for a chat failure cause. */
export function chatFailureMessage(cause: ChatFailureCause): string {
  return CHAT_FAILURE_MESSAGES[cause];
}
