# Error Model

Current verdict: Pass

## TransportError payload

All subclasses carry stable `code`, user message, retryability, channel, operation, correlation id, scope, optional phase, and optional caller kind.

## Failure policy

PR 0a validates error shape only. Runtime health transitions and production logging are later PRs.
