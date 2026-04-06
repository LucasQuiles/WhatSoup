# Bead: PERF-02 — Streaming Buffer and Hot-Path Allocation Optimization

**BeadID:** PERF-02

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/outbound-queue.ts`, `src/runtimes/agent/session.ts`, `src/core/jid-constants.ts`
**Input:** Audit findings: streamBuffer += text allocations, stdout chunk.toString += allocations, canonicalizeChatJid redundant calls
**Output:** Array-based string accumulation, reduced allocations in hot paths
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

Three hot-path allocation issues:

### 1. `streamBuffer += text` (outbound-queue.ts:~282)
Called on every streaming token (hundreds per turn). Each `+=` allocates a new string.

### 2. `stdoutBuffer += chunk.toString('utf8')` (session.ts:~620)
Called on every stdout data chunk from the child process. Each `+=` plus `toString()` creates two allocations.

### 3. `canonicalizeChatJid` called 2-3× per message (runtime.ts:~1236, 679, 702)
Each call does an unprepared SQLite `.prepare()` + `.get()`. For LID chats, this is 2-3 DB round trips per inbound message.

## Implementation Spec

### 1. Replace `streamBuffer` with string array

```typescript
// BEFORE:
private streamBuffer: string = '';
// enqueueStreamingText:
this.streamBuffer += text;
// flushStreamBuffer:
const text = this.streamBuffer; this.streamBuffer = '';

// AFTER:
private streamBufferParts: string[] = [];
// enqueueStreamingText:
this.streamBufferParts.push(text);
// flushStreamBuffer:
const text = this.streamBufferParts.join(''); this.streamBufferParts = [];
```

### 2. Replace `stdoutBuffer` with Buffer array

```typescript
// BEFORE:
private stdoutBuffer = '';
// on data:
this.stdoutBuffer += chunk.toString('utf8');

// AFTER:
private stdoutChunks: Buffer[] = [];
private stdoutBufferStr = '';
// on data:
this.stdoutChunks.push(chunk);
// before line splitting:
if (this.stdoutChunks.length > 0) {
  this.stdoutBufferStr += Buffer.concat(this.stdoutChunks).toString('utf8');
  this.stdoutChunks = [];
}
```

### 3. Cache `canonicalizeChatJid` result per message

In `_handleMessageInner`, compute once and thread through:

```typescript
const mapKey = this.sandboxPerChat
  ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid)
  : canonicalizeChatJid(chatJid, this.db);
// Pass mapKey to all subsequent calls instead of recomputing
```

Also cache the prepared statement in `canonicalizeChatJid` (covered by PERF-01 for durability, but this is a separate module-level cache in jid-constants.ts).

## Maybe I'm Wrong

### Assumption: String += is actually slower than array + join
**Validation:** V8 optimizes `+=` for some patterns (rope strings), but this optimization breaks down when concatenation happens across event loop ticks (which is exactly the case for streaming tokens and stdout chunks). Array + join is consistently fast for this pattern.
**Verdict: Well-established optimization.** Array + join is the standard recommendation for high-frequency string concatenation in Node.js.

## Required Tests

No new behavioral tests — pure refactor. Verify:
1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `streamBuffer` replaced with string array + join
- [ ] `stdoutBuffer` replaced with Buffer array + concat + toString
- [ ] `canonicalizeChatJid` result computed once per message and threaded through
- [ ] Typecheck + all existing tests pass

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
