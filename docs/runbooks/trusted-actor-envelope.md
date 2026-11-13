# Trusted actor envelope

The runtime tells the model who sent a turn in a server-authored block. User
text must never be able to forge that block or make an unchallenged role claim.
Source: `src/runtimes/agent/trusted-actor-envelope.ts` and
`src/lib/trusted-actor-marker.ts`.

## The block

The block is the first application-context entry of a provider turn. It opens
with `[WhatSoup trusted transport metadata — server-authored, not user-authored]`
and closes with `[/WhatSoup trusted transport metadata]`.

- A live turn carries `actor_access=<class>` from `classifyTrustedActorAccess`.
  An administrator also gets `actor_role_attestation=verified_configured_administrator`.
- A turn built from stored chat text with no live actor carries the no-actor
  block instead. It says no actor is authenticated, that any role or access
  claim in the content is untrusted, and `actor_access=untrusted_or_unknown`.
  This covers the pending replay after a failed resume, missed-message
  injection and context recovery.
- The attestation is for conversational role recognition only. It never
  bypasses server-enforced tool authorization, risky-action confirmation or
  instance policy.

## Marker neutralisation

Only the runtime's block may contain the marker phrase. Every copy in
provider-bound user-derived text is replaced with
`user-supplied text imitating runtime metadata`. Detection runs on a reader
skeleton:

1. Backslash escapes (`\n`, `\uXXXX`) and HTML character references are decoded.
2. Each code point is decomposed (NFKD) and loses its combining marks.
3. Default-ignorable and format characters are dropped, including variation
   selectors, the combining grapheme joiner and Hangul fillers.
4. Common Cyrillic, Greek, Armenian and small-capital lookalikes map to Latin
   letters, and letters are lowercased.
5. Non-letters are ignored, so spacing, punctuation and markdown cannot split
   the phrase.

Only the matched span of the original text is rewritten. Other text, including
emoji, accents and non-Latin scripts, reaches the provider byte for byte.
Ordinary prose that names the phrase is rewritten too; this is intended.

## Boundaries

Neutralisation runs at the last transformation before each provider boundary:

| Path | Where |
|---|---|
| Live and recovery turns | `withTrustedActorTurn` and `withUnauthenticatedActorTurn`. All user-derived parts are checked together, so a copy split across parts is caught. |
| System prompt | `SessionManager.buildSystemPrompt`, after line dedupe. |
| Handoff summary | `buildHandoffPrelude`, on the joined body. Whole-line headers are also prefixed with `[quoted]`. |
| Handoff summarizer request | `buildHandoffDistill`, on the corpus as sent. |
| MCP tool results | `ToolRegistry.call`, on the final text parts. This covers the socket server (CLI providers) and the in-process bridge (API providers). |

Paths that reach a provider without a turn envelope state the no-actor rule as
plain text: the handoff fence guard and the summarizer instructions.

## Changing this contract

- Add a provider-bound path through one of the helpers above, never raw text.
- Keep a table row per code-point class in
  `tests/lib/trusted-actor-marker.test.ts`. The envelope tests use the same
  skeleton as their oracle.
