# WhatSoup Phase 2 Release — 2026-04-05

## Summary

Phase 2 delivers 7 new features across 3 sprints, building on Phase 1's media access, content completeness, search, and voice synthesis. Combined with Phase 1, WhatSoup now has 140+ MCP tools covering the full WhatsApp feature surface.

## New Features

### Sprint A — Agent Polish
- **SP5: Typing Simulation** — `send_typing` tool sends composing/recording/paused indicators. Auto-typing before outbound messages configurable via `autoTyping` instance config.
- **SP6: Link Preview Opt-Out** — `send_message` and `reply_message` now accept `link_preview: 'off'` to suppress Baileys auto-preview. Per-instance `generateHighQualityLinkPreview` config option.
- **SP7: Media Cleanup** — `MediaRetentionTimer` with tiered retention (72h temp, 7d cache). `cleanup_media` tool with dry-run support. Automatic scheduler in main.ts.

### Sprint B — Platform Expansion
- **SP8: Status/Stories** — `post_status` (text, image, video) and `list_statuses` tools. Status@broadcast messages now stored (previously dropped). Status messages are non-response-worthy (don't trigger agent sessions).
- **SP10: Quoted Message Media** — `download_media` now accepts `quoted: true` to download media from quoted/replied messages via contextInfo traversal.
- **SP9: Broadcast Lists** — CUT. Proof test confirmed `broadcast: true` is vestigial in Baileys v7.0.0-rc.9. See `docs/sdlc/active/whatsapp-mcp-features/sp9-broadcast-proof.md`.

### Sprint C — Infrastructure
- **SP11: Message Scheduling** — `schedule_message`, `list_scheduled`, `cancel_scheduled` tools. New `scheduled_messages` table (MIGRATION_14). Scheduler loop with idempotency guard, retry (3 max), dead-letter state.

## Database Migrations

- **MIGRATION_14:** `scheduled_messages` table with INTEGER timestamps, partial index on pending/processing status.

## Configuration

New instance config options:
```json
{
  "autoTyping": "composing",              // 'composing' | 'recording' | 'off' (default: 'off')
  "generateHighQualityLinkPreview": true, // default: false
  "mediaRetention": {
    "tempHours": 72,                      // default: 72
    "cacheHours": 168,                    // default: 168 (7 days)
    "intervalHours": 6                    // default: 6
  }
}
```

## ElevenLabs TTS (Phase 1 SP4)

API key is now provisioned in GNOME Keyring (`service: elevenlabs`). Voice synthesis is fully operational — `send_voice_reply` tool works end-to-end.

## Statistics

- **Sub-projects delivered:** 10 (SP1-SP8, SP10-SP11)
- **Sub-projects cut:** 1 (SP9 — Baileys limitation)
- **Total commits:** 40+
- **New tests added:** ~150+
- **Test suite:** 3366 passed | 1 pre-existing failure
- **TypeScript:** Clean (0 errors from our work)
- **Canary smoke test:** 6/6 PASS on BES Bot instance

## Team

- **Q:** Orchestrator, foundation layers, SP1-SP4 foundation, SP6, SP7, SP9 proof test, SP11 infrastructure
- **BES Bot:** Implementation partner, SP1 download tool, SP2 parsing rewrite, SP3 search, SP5 typing, SP8 status tools, SP11 scheduling tools, independent code review

## Known Issues

- 1 pre-existing test failure: `stream-parsers.test.ts` (Codex parser — unrelated)
- Pre-existing TypeScript errors in `fleet/routes/data.ts`, `control-queue.ts`, `agent/runtime.ts` (unrelated to Phase 1/2)
- SP4 voice reply requires ElevenLabs API quota — monitor usage
