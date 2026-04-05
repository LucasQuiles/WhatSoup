# Bead: B13
**Status:** pending
**Type:** investigate
**Runner:** unassigned
**Dependencies:** [B04]
**Scope:** `src/runtimes/agent/session.ts`, `src/runtimes/agent/providers/gemini-acp-parser.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/codex-transport-gaps-20260404/beads/B13-decision-trace.md
**Deterministic checks:** grep -n 'geminiSessionId\|session/new' src/runtimes/agent/session.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
ORACLE FINDING: Gemini has the same crash resume gap as Codex. The Gemini path creates a session via JSON-RPC and loses it on crash. Investigate whether Gemini ACP supports session resume and whether the session ID is persisted to DB.

## Output
- Finding: Gemini resume feasibility + current persistence state
- If actionable: new bead B13a with implementation spec
