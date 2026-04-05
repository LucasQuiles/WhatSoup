# SP1 Media Access: Minimal Implementation Investigation

Date: 2026-04-05
Task: tmup task 040
Scope: SP1 only (`download_media`, `media_path`, download-at-ingest)

## Conclusion

The minimal SP1 implementation is smaller than the existing draft plan in `docs/superpowers/plans/2026-04-05-sp1-media-access.md`.

Recommended minimum:

1. Add `messages.media_path` with a new idempotent `MIGRATION_12`.
2. Add a small `updateMediaPath(db, messageId, filePath)` helper.
3. Surface `mediaPath` through MCP message reads by extending `MessageRow` + `rowToMessage()`.
4. Persist `media_path` in the existing agent ingest path right after `prepareContentForAgent()` writes the downloaded file.
5. Add a new `download_media` MCP tool that:
   - first returns the cached local file when `media_path` exists,
   - otherwise falls back to downloading from `raw_message`,
   - works in chat-scoped sandbox sessions.

Not required for the minimal cut:

- `content_text` / structured JSON extraction (`SP2`)
- FTS trigger changes (`SP2`)
- fleet API / console response changes
- chat runtime disk persistence
- `save_dir` parameter

## Evidence

### Existing media download already happens in the agent runtime

- `src/runtimes/agent/runtime.ts:79-156` downloads inbound media with Baileys `downloadMediaMessage()`, writes a temp file with `writeTempFile()`, and returns prompt text like `[Image: /path]`.
- `src/core/media-download.ts:17-42` already centralizes timeout and size-limit enforcement for runtime downloads.

This means the highest-value gap is not download logic itself. The missing piece is persistence of the downloaded path.

### Passive runtime still needs an on-demand MCP tool

- `src/runtimes/passive/runtime.ts:53-61` does not process inbound media at all.

So even with ingest-time persistence for agent sessions, passive instances still need `download_media` as the fallback access path.

### Current MCP scope rules make the spec's tool scope incorrect

- `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md:53-66` defines `download_media` as a `global` tool.
- `src/mcp/registry.ts:188-199` rejects global-scope tools in chat-scoped sessions.
- `src/runtimes/agent/runtime.ts:1734-1740` provisions sandbox workspaces with `SessionContext { tier: 'chat-scoped', ... }`.

Result: if `download_media` is implemented exactly as written in the spec, sandbox agents cannot call it.

Minimal fix: make `download_media` a `chat`-scope tool, not `global`.

### Cached paths need sandbox projection

- `src/runtimes/agent/runtime.ts:136` writes the downloaded file into the instance-level `config.mediaDir`.
- `src/runtimes/agent/runtime.ts:161-183` later copies that file into `workspacePath/media/` for sandbox readability.

If `media_path` stores the instance-level temp path, a chat-scoped agent still cannot `Read` that file directly. The MCP tool must project or copy cached files into `session.allowedRoot/media/` before returning them to a sandboxed caller.

### Error taxonomy is broader than the current shared helper supports

- `src/core/media-download.ts:32-42` returns `null` for oversize, timeout, and generic failures.

So the spec's structured fallback errors (`media_expired`, `download_timeout`, `file_too_large`) are not available "for free" if the tool simply wraps `downloadMedia()`. Minimal SP1 should either:

- accept a coarse `download_failed` error in v1, or
- implement tool-local classification around Baileys calls.

### Fallback from `raw_message` may need byte revival

- `src/core/ingest.ts:116` stores `raw_message` via `JSON.stringify(msg.rawMessage)`.
- There is no repo-wide revive logic for byte fields after `JSON.parse`.

Open question: do Baileys media fields like `mediaKey` survive storage in a shape that `downloadMediaMessage()` can use directly, or does fallback download need a small "revive Buffers/Uint8Arrays" pass first?

This needs a proof test before the fallback path is considered safe.

## DB Changes Required

Only one migration is needed for SP1:

### `MIGRATION_12`

Add a nullable `media_path` column to `messages` plus a partial index.

```sql
ALTER TABLE messages ADD COLUMN media_path TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_media_path
  ON messages(media_path)
  WHERE media_path IS NOT NULL;
```

Recommended implementation pattern in `src/core/database.ts`:

```ts
[12, (db: DatabaseSync) => {
  const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'media_path')) {
    db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_media_path ON messages(media_path) WHERE media_path IS NOT NULL');
}],
```

Why this shape:

- current last migration is `11`
- no FTS changes are needed for SP1
- the index should be created even on partially-migrated databases where the column already exists

## Baileys APIs Available For Media Download

The installed version is `@whiskeysockets/baileys@7.0.0-rc.9` (`package.json`).

Usable APIs:

### 1. `downloadMediaMessage()`

Available via the public root export:

- `node_modules/@whiskeysockets/baileys/lib/index.d.ts`
- `node_modules/@whiskeysockets/baileys/lib/Utils/messages.d.ts:85-87`
- `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:786-829`

Signature:

```ts
downloadMediaMessage(message, 'buffer' | 'stream', options, ctx?)
```

Notes:

- This is the same API already used by `AgentRuntime`.
- It internally unwraps media content and delegates to `downloadContentFromMessage()`.
- It supports a `ctx.reuploadRequest()` callback for 404/410 reupload flows, but no such callback exists in this repo today.

Recommendation: use this for the minimal SP1 tool because it matches existing runtime behavior.

### 2. `downloadContentFromMessage()`

- `node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.d.ts:88`
- `node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js:397-403`

This is the lower-level API that downloads and decrypts from `{ mediaKey, directPath, url }`.

Recommendation: keep this as a fallback option only if `downloadMediaMessage()` proves incompatible with JSON-parsed `raw_message`.

### 3. Useful helpers

- `assertMediaContent()` in `messages.d.ts:87`
- `extractMessageContent()` in `messages.d.ts:32`
- `getUrlFromDirectPath()` in `messages-media.d.ts:87`

These are useful if the implementation needs to debug or recover from `raw_message` shape issues.

## Minimal File Set

Required:

- `src/core/database.ts`
- `src/core/messages.ts`
- `src/mcp/tools/media.ts`
- `src/mcp/register-all.ts`
- `src/runtimes/agent/runtime.ts`

Tests to touch:

- `tests/core/database.test.ts`
- `tests/core/messages.test.ts`
- `tests/mcp/tools/media.test.ts`
- `tests/runtimes/agent/prepare-content.test.ts`

Optional follow-up, not minimal:

- `src/runtimes/chat/media/processor.ts`
- any fleet/console files

## Recommended Minimal Design

### 1. Persist only the canonical cached path

Store the instance-level temp file path in `messages.media_path`.

Do not store workspace-specific paths in the DB. Those are per-session projections, not durable canonical cache locations.

### 2. Make `download_media` chat-scoped

Use:

- `scope: 'chat'`
- `targetMode: 'caller-supplied'`

Then:

- global sessions can still see and call it
- chat-scoped sessions can also use it
- handler must validate `row.conversation_key === session.conversationKey` when `session.tier === 'chat-scoped'`

### 3. Project returned files into sandbox workspaces when needed

If `session.allowedRoot` is set:

- cached global file path should be copied into `allowedRoot/media/`
- fresh downloads should still be cached in the global temp dir and persisted there
- the tool should return the workspace-local projected path to the sandboxed caller

This preserves one canonical cache path in the DB while still making the file readable inside sandboxed workspaces.

### 4. Keep agent-runtime persistence in the first cut

`AgentRuntime` already downloads media during inbound handling. This is the cheapest place to add reliable download-at-ingest persistence.

Recommended change:

- extend `prepareContentForAgent()` to accept `db` + `messageId`, or
- add a small callback/return structure so the caller can persist the written path

Avoid parsing paths back out of the formatted text string.

### 5. Leave chat-runtime disk persistence as a follow-up

`ChatRuntime` does download media, but chat instances do not expose MCP sockets (`README.md`, `docs/configuration.md`).

So chat-runtime disk persistence improves completeness, but it is not required to close the MCP access gap.

## Implementation Plan

### Phase 1: Schema and read-surface

1. Add `MIGRATION_12` in `src/core/database.ts`.
2. Add `media_path: string | null` to `MessageRow` in `src/core/messages.ts`.
3. Extend `rowToMessage()` to return `mediaPath`.
4. Add `updateMediaPath(db, messageId, filePath)`.

Verification:

- migration test for column + partial index
- mapper test proving `mediaPath` appears in `rowToMessage()`

### Phase 2: Agent ingest persistence

1. Update `prepareContentForAgent()` in `src/runtimes/agent/runtime.ts` to persist the path immediately after `writeTempFile()`.
2. Pass `this.db` and `msg.messageId` from the call site.

Verification:

- unit test that a successful media write calls `updateMediaPath()` with the written temp path

### Phase 3: `download_media` MCP tool

1. Extend `MediaDeps` to include `db.raw`.
2. Pass `db.raw` from `src/mcp/register-all.ts`.
3. Register `download_media` in `src/mcp/tools/media.ts`.

Handler flow:

1. Look up `message_id`, `conversation_key`, `content_type`, `media_path`, `raw_message`.
2. If missing row: return `not_found`.
3. If chat-scoped and conversation mismatch: return `not_found` or access error.
4. If `content_type` is not one of `image|video|audio|document|sticker`: return `unsupported_type`.
5. If `media_path` exists on disk:
   - return it directly for global callers
   - copy it into `allowedRoot/media/` and return the copied path for sandbox callers
6. Otherwise attempt on-demand download from `raw_message`.
7. Cache the fresh global path in `media_path`.
8. Return the projected path appropriate to the session.

Verification:

- cached path works
- unsupported type rejected
- chat-scoped caller cannot access another conversation's message
- sandbox caller receives a path under `allowedRoot`
- fresh fallback path at least works with a mocked Baileys downloader

### Phase 4: Fallback hardening

Before depending on DB-backed fallback in production:

1. add a proof test for `raw_message` round-trip compatibility with `downloadMediaMessage()`
2. if needed, add a revive step for Buffer-like fields before passing the object to Baileys
3. decide whether v1 returns a coarse `download_failed` or whether the tool implements typed error classification locally

This phase can ship after the cached-path flow if the team wants the smallest possible initial merge.

## Recommended Non-Goals For Minimal SP1

Do not include these in the first patch:

- `content_text`
- structured JSON content extraction
- FTS trigger rebuild
- `save_dir` parameter
- chat-runtime disk persistence
- fleet API / console `mediaPath` plumbing

Those belong to SP2 or to a second SP1 refinement pass.

## Open Questions

1. Does JSON-parsed `raw_message` need Buffer revival for `mediaKey` and related fields?
2. Should fallback error reporting be coarse in v1 (`download_failed`) or typed?
3. Should `download_media` return `mime_type` when using a cached path with no surviving `raw_message`?

My recommendation:

- treat (1) as a required proof test before relying on fallback
- keep (2) coarse for the minimal merge unless typed errors are explicitly required
- treat (3) as best-effort inference, not a blocker
