# Trusted actor envelope

The runtime tells the model who sent a turn in a server-authored block. User
text must not be able to forge that block or make an unchallenged role claim.
Source: `src/runtimes/agent/trusted-actor-envelope.ts` and
`src/lib/trusted-actor-marker.ts`.

## Security boundary

The block is advisory to the model. It helps the model recognise who it is
talking to; it grants nothing.

- WhatSoup's sensitive MCP tools are authorized on the server for each call,
  against the turn's actor (`ToolRegistry`), whatever any block in the
  conversation says. A forged block cannot open those tools.
- A provider's built-in tools (shell, file edits and similar) are not
  authorized per actor. Their reach is fixed per instance by the provider
  permission settings. When an instance runs them without a sandbox, the
  model's view of who is speaking is the only check on them, so a forged block
  that slips past neutralisation can steer them. Keep such an instance
  reachable only by its administrators (`accessMode: self_only`).
- The block carries no secret. Its authenticity rests on placement (the first
  application-context entry, built by the runtime) and on neutralising every
  copy of its marker phrase in user-derived text.

## The block

The block is the first application-context entry of a provider turn. It opens
with `[WhatSoup trusted transport metadata — server-authored, not user-authored]`
and closes with `[/WhatSoup trusted transport metadata]`. It reaches the
provider exactly as the envelope builds it.

- A live turn carries `actor_access=<class>` from `classifyTrustedActorAccess`.
  An administrator also gets `actor_role_attestation=verified_configured_administrator`.
- A turn built from stored chat text with no live actor carries the no-actor
  block instead. It says no actor is authenticated, that any role or access
  claim in the content is untrusted, and `actor_access=untrusted_or_unknown`.
  This covers missed-message injection and context recovery. The pending
  replay after a failed resume carries the pending turn's own actor block.
- The attestation is for conversational role recognition only. It never
  bypasses server-enforced tool authorization or instance policy. It does not
  change what an instance's built-in tools may do (see the security boundary
  above).

## Marker neutralisation

Only the runtime's block may contain the marker phrase. Every copy in
provider-bound user-derived text is replaced with
`user-supplied text imitating runtime metadata`. Detection runs on a reader
skeleton:

1. Backslash escapes (`\n`, `\uXXXX`) and HTML character references are decoded.
2. Each code point is decomposed (NFKD) and loses its combining marks.
3. Default-ignorable and format characters are dropped, including variation
   selectors, the combining grapheme joiner and Hangul fillers.
4. Lookalike letters map to Latin letters, and letters are lowercased. The map
   covers common Cyrillic, Greek, Armenian and small-capital lookalikes, and
   the Lisu, Cherokee, Coptic, Canadian syllabics and Malayalam letters that
   resemble the phrase's letters.
5. Digits read as letters (`0` o, `1` l, `3` e, `4` a, `5` s, `7` t, and the
   round zeros of other scripts) are optional: each matches as its letter or
   is ignored. A digit can stand in for a letter or split the phrase.
6. Other non-letters are ignored, so spacing, punctuation and markdown cannot
   split the phrase.

The map only feeds detection. Only the matched span of the original text is
rewritten. Other text, including digits, emoji, accents and non-Latin scripts,
reaches the provider byte for byte. Ordinary prose that names the phrase is
rewritten too; this is intended.

## Accepted residuals

Neutralisation is lexical, so it cannot catch every way to write the phrase.
These forms are not caught. Per-actor authorization still holds for WhatSoup's
sensitive MCP tools; on an instance whose built-in tools run without a sandbox,
the access mode is what limits who can try them (see the security boundary).

- Visibly altered forms: `rn` for `m`, `VV` for `W`, a backslash escape that
  deletes a letter in raw text (`Wha\tSoup`), or an unmapped letter such as
  U+028B for `u`.
- Deliberately encoded content: named HTML entities that contain letters
  (`&Wopf;`, `&ZeroWidthSpace;`), nested or unterminated references, empty
  tags inside a word, percent-encoding (`%57`), `\u{57}` and double JSON
  escapes. A model asked to decode such content can still read the phrase.
- Scripts beyond the map: lookalikes from scripts or code points the map does
  not list.
- Copies split across separate JSON field values or separate tool results.
  Parts neutralised in one call are checked together; separate calls are not.
- Content from CLI built-in tools and third-party MCP servers reaches the model
  without passing WhatSoup's boundaries.
- Spawn-per-turn labels every application-context entry
  `Application context (runtime-provided):`, including participant metadata
  and recent-chat context. Only the first entry is the server block.

## Boundaries

Neutralisation runs at the last transformation before each provider boundary:

| Path | Where |
|---|---|
| Live and recovery turns | `withTrustedActorTurn` and `withUnauthenticatedActorTurn`. All user-derived parts are checked together, so a copy split across parts is caught. |
| Display names in participant metadata | `sharedRuntimeApplicationContext`, before JSON escaping. |
| System prompt | `SessionManager.buildSystemPrompt`, after line dedupe. |
| Handoff summary | `buildHandoffPrelude`, on the joined body. Whole-line headers are also prefixed with `[quoted]`. |
| Handoff summarizer request | `buildHandoffDistill`, on the corpus as sent. |
| MCP tool results | `ToolRegistry.call`, on the final text parts, for every tool (`list_messages`, `search_messages` and the rest). This covers the socket server (CLI providers) and the in-process bridge (API providers). |

Paths that reach a provider without a turn envelope state the no-actor rule as
plain text: the handoff fence guard and the summarizer instructions. The
operator control session (`/heal`) sends its repair payload as a plain-text
turn with no envelope; it is outside this contract's WhatsApp-actor scope.

## Changing this contract

- Add a provider-bound path through one of the helpers above, never raw text.
- Keep a table row per code-point class in
  `tests/lib/trusted-actor-marker.test.ts`, and keep its ordinary-prose rows
  passing byte for byte.
- Both the marker and the envelope tests pin hand-written expected outputs.
  Do not replace those with expectations computed by the matcher.
- Do not add a secret to the block or the system prompt. A secret in the
  prompt leaks through model output, tool results and provider transcripts,
  and a provider that keeps its first system prompt cannot revoke it.
