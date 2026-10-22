# WhatSoup Fleet Console

React/Vite console for operating the embedded WhatSoup fleet server. The app is built into the repository-level `dist/` directory and served by the fleet server alongside `/api/*`.

## Commands

Run from the repository root unless noted:

```bash
npm --prefix console ci
npm --prefix console run dev
npm --prefix console run build
npm --prefix console run lint
```

`npm --prefix console run build` runs `tsc -b` and `vite build`, then writes the production SPA to `dist/`. The root release verification uses this build output for the fleet server's static handler.

## Development Proxy

`npm --prefix console run dev` starts Vite and proxies `/api/*` to the local fleet server at `http://127.0.0.1:9099`.

The dev proxy reads the fleet token from the local WhatSoup config and injects it as a Bearer token for proxied API requests. Start the fleet server separately before using live data:

```bash
npm run fleet
npm --prefix console run dev
```

The `/api/lines/*/auth` Server-Sent Events path keeps buffering disabled in the proxy so QR/auth events stream to the browser immediately.

## Production Serving

In production, the fleet server serves:

- `dist/index.html` and static assets for the console UI
- `/api/*` routes from `src/fleet/index.ts`
- WebSocket updates from the fleet WebSocket server

The production static handler adds public version and session-mode metadata to
the HTML. It does not embed the fleet token. The console unlocks through
`POST /api/console-session` and uses an HttpOnly session cookie. See
[console authentication](../docs/console-guide.md#console-authentication) for
the session and logout behavior.

## Mock Fallback

The API client in `src/lib/api.ts` probes `/api/lines`. Development builds can
fall back to `src/mock-data.ts` for supported reads. Production builds disable
that fallback unless built with `VITE_MOCK_MODE=1`; a failed live API remains an
error. Writes always require a live fleet server.

The [console guide](../docs/console-guide.md) owns the page walkthrough and
[mock-mode contract](../docs/console-guide.md#mock-mode). The
[design-system index](../docs/design-system/README.md) separates design requirements
from historical implementation evidence.
