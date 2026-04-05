# SDLC Task: Wire Console to Real Fleet API

**Task ID:** control-plane-20260401
**Profile:** BUILD
**Complexity:** Complicated
**Cynefin:** Complicated (well-defined API, integration work)
**Status:** Scout → Plan
**Created:** 2026-04-01

## Mission Brief

Wire the WhatSoup Console frontend to the real fleet API, replacing all mock data with live instance data. The control-plane backend already exists at `src/fleet/`. The Phase 1 health extensions (instance block, runtime block, POST /access) were just shipped. This task connects the two layers.

### Source Spec
- `/home/q/LAB/WhatSoup/docs/specs/2026-03-31-whatsoup-console-design.md` §3-5
- Build Sequence Step 2

### Prerequisites (completed)
- Step 1: WhatSoup Phase 1 backend extensions (GET /health extended, POST /access added, token provisioning)

### Success Criteria
1. Control-plane starts as a standalone Node.js service
2. Fleet discovery scans `~/.config/whatsoup/instances/*/config.json`
3. Health aggregation polls each instance's extended GET /health
4. REST API serves all v1 endpoints from spec §5.1
5. Console frontend can replace mock data with real API calls
6. Build passes, service starts without errors

### API Surface (from spec §5.1)
```
GET   /api/lines                    Fleet discovery + health rollup
GET   /api/lines/:name              Line detail (config + health + stats)
GET   /api/lines/:name/chats        Chat list from instance DB
GET   /api/lines/:name/messages     Messages (cursor pagination)
GET   /api/lines/:name/access       Access list
GET   /api/lines/:name/logs         Log tail
POST  /api/lines/:name/send         Send message (mode-aware routing)
POST  /api/lines/:name/access       Access decision (proxy to instance)
POST  /api/lines/:name/restart      Restart instance via systemctl
PATCH /api/lines/:name/config       Update config + restart
```

## Phase Log
- 2026-04-01: Task created, entering Frame phase
