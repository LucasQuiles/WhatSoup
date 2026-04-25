# Error Catalog

Current verdict: Pass

| Error class | Code | Scope | Trace fields |
|---|---|---|---|
| UnsupportedCapabilityError | `transport.unsupported_capability` | runtime/request | channelId, operation, correlationId, callerKind |
| PayloadTooLargeError | `transport.payload_too_large` | request | channelId, operation, correlationId |
| ConversationNotFoundError | `transport.conversation_not_found` | conversation | channelId, operation, correlationId |
| AuthRequiredError | `transport.auth_required` | provider | channelId, operation, correlationId |
| RateLimitedError | `transport.rate_limited` | provider | channelId, operation, correlationId |
| TransientProviderError | `transport.transient_provider` | request/provider | channelId, operation, correlationId, phase |
| PermanentProviderError | `transport.permanent_provider` | request/conversation/channel/provider | channelId, operation, correlationId |
| SendAmbiguousError | `transport.send_ambiguous` | request | channelId, operation, correlationId, phase |
