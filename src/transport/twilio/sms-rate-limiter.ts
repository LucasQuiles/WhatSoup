// src/transport/twilio/sms-rate-limiter.ts
/**
 * Per-destination sliding-window rate limiter for outbound SMS (QR-068).
 *
 * The window shape was generalized to `src/transport/outbound-rate-limiter.ts`
 * (PR-F) so the WhatsApp socket governor and the Twilio adapter share ONE
 * implementation instead of a third copy of the timestamp-window pattern.
 * `SmsRateLimiter` is now a name-preserving re-export: the Twilio adapter's
 * `new SmsRateLimiter(smsPerMinute)` and its `acquire()`/`size` contract are
 * unchanged (the delay-not-reject SMS semantics live in `acquire()`).
 */
export { OutboundRateLimiter as SmsRateLimiter } from '../outbound-rate-limiter.ts';
