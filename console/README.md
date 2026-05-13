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

The production static handler injects fleet metadata into served HTML so the console API client can authenticate browser requests back to the same fleet origin.

## Mock Fallback

The API client in `src/lib/api.ts` probes `/api/lines`. If the fleet server is unavailable, it falls back to `src/mock-data.ts` so design and demo views still render. This fallback is expected during UI iteration, but operational testing should run with the fleet server online.

Mock fallback applies to read-oriented console surfaces. Mutating operations should be validated against a running local fleet server.
