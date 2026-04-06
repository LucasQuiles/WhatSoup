# Bead: LEAK-06 — Socket Server `stop()` Must Destroy Active Connections

**BeadID:** LEAK-06

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/mcp/socket-server.ts`, `src/runtimes/agent/media-bridge.ts`
**Input:** Audit finding: `stop()` calls `server.close()` but doesn't destroy active sockets
**Output:** Active client sockets are destroyed on `stop()`
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 0
**Loop depth:** L0 + L1
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

### WhatSoupSocketServer (`socket-server.ts`)

`stop()` at L134-145:
1. `connectionSessions.clear()` — removes session entries
2. `server.close()` — stops accepting new connections
3. `unlinkSync(socketPath)` — removes socket file

Problem: `server.close()` does NOT destroy existing open sockets. Any `whatsoup-proxy.ts` processes still connected have their socket, closure references (`buf`, `connSession`), and event listeners kept alive until the remote process exits. The `'close'` event on those sockets will eventually fire, but the `connectionSessions.delete()` at L76 runs against an already-cleared map (no-op).

### MediaBridge (`media-bridge.ts`)

Cleanup function at L135-139:
```typescript
server.close(() => { unlinkSync(socketPath); });
```

Same issue — doesn't destroy active connections. Less severe because `send-media-server.ts` clients are short-lived (one request → exit), but structurally the same leak.

## Implementation Spec

### 1. Track active sockets in WhatSoupSocketServer

Add a socket tracking map alongside `connectionSessions`:

```typescript
private readonly activeSockets = new Map<number, net.Socket>();
```

In the connection handler (~L64), after creating `clientId`:

```typescript
this.activeSockets.set(clientId, socket);

socket.on('close', () => {
  this.connectionSessions.delete(clientId);
  this.activeSockets.delete(clientId);  // ADD
  // ... existing logging ...
});
```

### 2. Destroy active sockets in `stop()`

```typescript
stop(): void {
  // Destroy all active client connections first
  for (const [clientId, socket] of this.activeSockets) {
    socket.destroy();
  }
  this.activeSockets.clear();
  this.connectionSessions.clear();

  if (this.server) {
    this.server.close();
    this.server = null;
  }
  // ... existing unlinkSync ...
}
```

### 3. Track and destroy active sockets in MediaBridge

In `startMediaBridge()`, add a Set to track connections:

```typescript
const activeSockets = new Set<net.Socket>();

server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
  // ... existing data handler ...
});

const cleanup = function () {
  // Destroy active connections first
  for (const s of activeSockets) s.destroy();
  activeSockets.clear();
  server.close(() => {
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  });
} as MediaBridge;
```

## Maybe I'm Wrong

### Assumption: Active sockets leak after `server.close()`
**Validation needed:** Verify that Node.js `net.Server.close()` does NOT destroy existing connections.
- Node.js docs confirm: "Stops the server from accepting new connections and keeps existing connections." ([net.Server.close()](https://nodejs.org/api/net.html#serverclosecallback))
- **Verdict: Confirmed.** Active connections survive `server.close()`.

### Assumption: `whatsoup-proxy.ts` connections are long-lived
**Validation needed:** Check how `whatsoup-proxy.ts` connects and when it disconnects.
- The proxy reads stdin via readline and relays to the socket. It exits when `rl.on('close')` fires (stdin EOF from Claude Code exit). So the connection lives as long as the Claude Code session.
- If the Claude Code session crashes but the proxy hasn't received stdin EOF yet, the socket stays open.
- **Verdict: Confirmed.** Connections can outlive the logical session by seconds to minutes.

### Assumption: This matters in practice
**Validation needed:** How many concurrent connections are typical?
- In `sandboxPerChat` mode: 1 connection per active workspace. With N active chats, up to N connections. After eviction (LEAK-04), the socket server is stopped but connections aren't destroyed.
- In non-sandbox mode: 1 global socket server, N concurrent connections from N Claude Code sessions.
- For a bot with 5-10 active chats, this is 5-10 leaked FDs per stop cycle. Not catastrophic, but it compounds if workspaces are frequently evicted and re-created.
- **Verdict: Low-to-medium severity in practice, but a correctness issue that should be fixed.**

### Risk: Destroying sockets mid-request could cause data loss
**Assessment:** `whatsoup-proxy.ts` is a stateless relay. If the socket is destroyed mid-request, the MCP tool call fails and Claude Code retries or reports an error. This is the same behavior as a network failure. The socket is only destroyed when the server is shutting down (the session is already ending), so tool calls would fail anyway.
- **Verdict: Safe.** Destroying sockets on stop is the correct behavior.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. Manual: start instance, connect MCP client, call `stop()`, verify no lingering socket FDs (`lsof -p <pid> | grep sock`)

## Acceptance Criteria

- [ ] `WhatSoupSocketServer` tracks active sockets in a Map
- [ ] `stop()` calls `socket.destroy()` on all active sockets before `server.close()`
- [ ] `MediaBridge` cleanup function destroys active sockets
- [ ] Socket tracking is cleaned up on normal `close` event
- [ ] Typecheck passes
- [ ] All tests pass

## Loop Protocol

### L0 — Implementation
- Worker implements the spec in an isolated clone
- Must produce `bead-output.md` with `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must pass: `npm run typecheck && npx vitest run`
- Bridge advances: `running` → `submitted`

### L1 — Sentinel Review  
- Different-model agent reviews the implementation
- Validates: code matches spec, tests are durable/repeatable/observable/provable, no regressions
- Bridge advances: `submitted` → `verified`

### L2 — Oracle Consensus
- Third-model agent validates architectural correctness
- Confirms: no unintended side effects, integration safety, edge cases covered
- Bridge advances: `verified` → `proven`

### Output Requirements
- `bead-output.md` must exist in clone root
- Must contain `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must be >100 bytes
- Must include: commit hash, test results, files changed
