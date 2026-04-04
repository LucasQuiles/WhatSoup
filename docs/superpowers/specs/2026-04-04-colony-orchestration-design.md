# Colony Orchestration Architecture: Persistent Multi-Agent System

**Date:** 2026-04-04
**Status:** Draft
**Authors:** Q (human) + L (lab agent)
**Scope:** Architecture for a persistent, self-learning multi-agent system with cross-model collaboration, scoped autonomy, and layered escalation

---

## 1. Problem Statement

The current multi-agent system operates in batch mode: a human initiates a task, agents execute it, work stops. Between sessions, no agents are active. Context is lost at session boundaries. Cross-model collaboration (Claude + Codex) happens manually — the human mediates handoffs, reviews, and routing decisions.

This spec designs a system that:
- Persists while the human is away, continuing productive work within authorized scope
- Discovers problems through observation, not just assignment — detecting friction, repeated failures, resurfacing defects, and stalling progress
- Collaborates across models (Claude, Codex, local models, enrichment services) with structured handoff and dynamic role assignment
- Feeds every observation — success and failure — back into the system as compounding operational memory
- Escalates through machine layers before involving a human
- Treats agents not as disposable task executors but as participants in a continuous investigative and corrective organism

---

## 2. Design Principles

### Principle 1: Shared Operational System of Record

Not one literal store — a composed surface of synchronized artifacts. Task state, artifacts, journals, findings, decisions, escalation records, and enrichment outputs. Every worker operates against the same persisted truth under the same orchestration protocol.

The system of record may include: markdown files (beads, journals, specs), SQLite databases (tmup task DAG, operational state), structured logs (JSONL event streams), queue records, issue objects, enrichment outputs, and Git-backed artifacts. The principle is not format uniformity but truth uniformity — all participants read and write the same persisted state.

### Principle 2: Cross-Model Adversarial-Complementary Collaboration

Any capable agent may draft, expand, critique, validate, enrich, or adjudicate depending on task type and model strengths. Not a fixed author/reviewer pipeline. Claude's planning and process control strengths, Codex's broader codebase grounding, BRIC's evidence generation, local models' cost-effective triage — dynamic role assignment per task.

The handoff between models is artifact-mediated, not conversation-mediated. One model produces structured output into a shared artifact; the next model picks it up. The DAG handles sequencing for bead-to-bead handoffs. Review loops are the primary collaboration primitive, where one model critiques, expands, or validates another's work — but the reviewer role is not fixed. Either model may lead or review depending on task characteristics.

### Principle 3: Scoped Autonomy with Domain-Aware Boundaries

Within the active mission/domain, agents may discover and enqueue follow-on work autonomously. Outside the active mission/domain, agents may audit, annotate, cluster, and flag — but not self-authorize new campaigns. Promotion across domain boundaries climbs the machine hierarchy before reaching a human.

This means:
- **In-scope work:** Agents discover adjacent issues during task execution and may create follow-on beads, enqueue fixes, and execute them within the current mission.
- **Out-of-scope discovery:** Agents may inspect, annotate, cluster, and create exploratory issues — but these do not become autonomous action. They route upward through machine layers.
- **Domain boundary crossing:** Requires adjudication through the escalation hierarchy. Lower tiers enrich and classify. Higher tiers decide whether to promote, defer, suppress, or escalate further.

### Principle 4: Tiered System Integration

The system comprises five distinct tiers of participants:

| Tier | Examples | Behavior |
|------|----------|----------|
| **Workers** | Claude Code, Codex CLI, Gemini CLI | Execute tasks, produce artifacts, report completion/failure |
| **Orchestrators** | Conductor, Orchestrator | Route, prioritize, enforce scope, mediate transitions |
| **Daemon services** | Deacon, local model triage | Persistent watchers, health monitors, event routing |
| **Enrichment/evidence services** | BRIC, Pinecone semantic search, static analyzers | Preprocess, enrich, extract, cluster, surface anomalies |
| **Memory/retrieval layers** | Episodic memory, Pinecone indexes, SQLite state | Store and retrieve context, decisions, patterns, history |

All tiers write back into the shared operational system of record. The orchestration protocol treats them as participants with different capabilities and lifecycle models, not as a flat peer set.

### Principle 5: State Transitions and Scope Authorization Over Model Selection

The system is organized around:
- **What state exists** — the current operational surface
- **What protocol governs transitions** — how work moves between states
- **What scope is authorized** — what each agent/layer may act on
- **What layer handles escalation** — where ambiguity and boundary-crossing decisions go

Not "which model talks next." Model selection is a routing decision made by the orchestration layer based on task characteristics, not a first-class architectural concept.

### Principle 6: Autonomy Bounded by Evidence, Scope, and Escalation Rules

Agents do not invent new campaigns, silently cross domains, or convert weak signals into action without sufficient corroboration. Unknowns, anomalies, and low-confidence discoveries must be recorded in a way that preserves context and routes upward through machine layers before human escalation.

Autonomy is not "freedom to roam." It is "freedom to continue operating productively within scope, while continuously converting experience into usable system memory."

### Principle 7: Decision Anchor Points Survive Handoff Without Summary Collapse

Each important transition preserves both structured fields AND enough narrative context to retain nuance:

- What was observed
- What was inferred
- What was changed
- What was attempted and rejected
- What evidence supported the decision
- What remains uncertain
- What follow-on work was generated
- What scope assumptions the decision made

Not pure structure (loses nuance) and not pure prose (loses precision). Paired structured + narrative capture at every significant transition.

### Principle 8: Layered Mediation and Escalation

Transitions, routing, prioritization, scope enforcement, reconciliation, and escalation are handled through a hierarchy of machine layers. The orchestrator is the top automated arbiter before human involvement. Issues climb: worker → reviewer → conductor → orchestrator → enrichment services → human.

Human escalation is the last resort, not the default safety valve. Each machine layer must exhaust its ability to safely reason about an issue before passing it upward.

### Principle 9: Continuous Backpressure and Learning Capture

Failures, retries, dead ends, repeated fixes, resurfacing defects, queue starvation, escalation frequency, and success patterns are not passive logs — they are structured signals. Captured, clustered, enriched, prioritized, and reused by later agents.

Backpressure is a central signal, not a side effect:
- A task stuck three times is evidence about policy limits, insufficient context, or need for stronger enrichment
- A pattern that resolves cleanly ten times is a candidate for automation, better thresholds, or a reusable protocol fragment
- Oscillating decisions, unresolved ambiguity, recurring regressions, spike patterns in escalations, and repeated human intervention dependency are all captured and fed back into routing, prioritization, and playbook refinement

### Principle 10: Issue Consolidation, Prioritization, and Persistence of Salience

Findings are grouped, deduplicated, categorized, ranked, tracked, and kept salient while active. Priority is not lost across sessions, handoffs, or queue churn.

Flat accumulation of findings is noise. The system must actively consolidate related issues, detect duplicates, maintain priority rankings, and ensure that important unresolved items remain visible as new work flows through the system.

### Principle 11: Staged Preprocessing for Large-Context Work

When agents need to inspect large corpora, they submit staged read requests to enrichment daemons. The daemon preprocesses, chunks, tags, extracts metadata, highlights anomalies, and returns distilled artifacts. Reasoning agents act on distilled results, not raw bulk input. This reduces token waste, prevents missed buried context, and gives orchestration layers better raw material for adjudication.

### Principle 12: Compounding Operational Memory Through Continuous Feedback Loops

The system continuously recaptures backpressure, stuck work, failures, retries, regressions, and successes as structured operational signals. Each pass through the system should increase contextual grounding, improve evidence quality, sharpen future routing and escalation, and expand the corpus of reusable patterns.

When agents succeed: retain what pattern was recognized, what evidence was used, what action resolved it, what follow-on checks were valuable, and under what scope assumptions the fix was safe.

When agents fail: retain what was attempted, where reasoning broke down, what evidence was missing, what signals were misleading, which layer caught the problem, and whether it reflects a recurring failure mode.

Over time, this turns the system from a stateless executor into a compounding operational memory.

**Self-learning does not mean uncontrolled self-modification.** The loop continuously accumulates observations, failure modes, success cases, heuristics, evidence patterns, and enriched references. But changes to policy, thresholds, promotion rules, or autonomy boundaries require adjudication through the machine hierarchy and, for consequential changes, human approval. The system becomes better informed every pass without becoming self-rewriting in unsafe ways.

### Principle 13: BRIC as Universal Enrichment Substrate

BRIC and similar services are available across the workflow as staging, preprocessing, evidence generation, metadata enrichment, embedding, anomaly surfacing, and context compression layers. BRIC is not merely adjacent to the workflow — it is part of the fabric that keeps the workflow grounded.

BRIC serves multiple roles depending on context:
- **Daemon service:** Always available to preprocess, categorize, extract metadata, build embeddings, surface entities, attach line references, identify buried signals
- **Evidence service:** Higher-tier agents call BRIC when they need stronger grounding before promoting or escalating a finding
- **Delegated subprocessor:** Agents stage files, logs, diffs, or artifacts; BRIC processes and writes back distilled artifacts for other agents to reason over
- **Backpressure clustering:** BRIC helps cluster retries, correlate failure modes, detect resurfacing regressions, turn raw operational noise into structured signals
- **Compression loss mitigation:** When handoffs risk summary collapse, BRIC produces denser evidence bundles for more faithful context transfer

---

## 3. The Autonomy Model

### 3.1 Persistent Investigative Organism

The system is autonomous not merely in the sense that it can execute without supervision. It is autonomous in the stronger sense that it can continue operating as a persistent investigative and corrective organism while the human is away.

Agents do not just consume assigned work. They also:
- Observe the environment they operate in
- Detect friction and repeated failure patterns
- Notice resurfacing defects
- Recognize where progress is stalling
- Feed those signals back into the system in structured form

### 3.2 Exploratory Issues as First-Class Objects

When an agent encounters something that appears to cross a mission boundary, represent a new pattern, or indicate a new domain, it creates an **exploratory issue** — not an executable task.

Exploratory issues carry:
- Evidence (what was observed)
- Confidence level
- Affected scope
- Suspected domain
- Related findings and possible duplicates
- Suggested next actions
- Reason it was not auto-promoted

This lets the system retain ambiguity without either discarding it or acting recklessly on it.

### 3.3 Escalation Path for Exploratory Issues

```
Agent discovers boundary-crossing concern
    ↓
Creates exploratory issue with evidence
    ↓
Lower-tier agents enrich, cluster, compare to prior incidents, classify
    ↓
Higher-tier agents adjudicate: novel? existing campaign? suppress? defer? promote?
    ↓
Only after machine layers exhaust their reasoning → surface to human
```

### 3.4 Multi-Channel Discovery Model

| Channel | Trigger | Scope | Default behavior |
|---------|---------|-------|------------------|
| **Adjacency discovery** | Task completion | Neighborhood of completed work | Safest default — stays near understood code |
| **Scheduled audit** | Orchestrator-initiated beads | Controlled scope per audit type | Explicit discovery as a work type |
| **Passive observation** | Backpressure capture | System-wide operational signals | Failures, retries, regressions, anomalies |
| **Enrichment-driven** | BRIC/Pinecone surfacing | Indexed data anomalies | Services identify buried patterns |

**Discovery is broad. Promotion is narrow.** Agents discover and log far more than they promote and execute. When the active mission is exhausted, agents continue observing, auditing, consolidating, and enriching — but do not invent autonomous campaigns outside authorized boundaries.

---

## 4. Component Architecture

### 4.1 Layer Diagram

```
Human (periodic check-in, escalation endpoint)
    ↑ escalates to
Orchestrator Layer
  - Conductor (ephemeral LLM sessions, Opus-class)
  - Scope enforcement, promotion/suppression, reconciliation
    ↑ spawned by / reports to
Daemon Layer
  - Deacon (persistent daemon, systemd-managed)
  - Small local model for intelligent triage (optional)
  - BRIC daemon (enrichment, preprocessing, evidence)
    ↑ coordinates
Worker Layer
  - Claude Code workers (tmux panes, claude-cli)
  - Codex CLI workers (tmux panes, codex-cli)
  - Specialty workers (Gemini, local models, external APIs)
    ↑ reads/writes
Shared Operational System of Record
  - Bead files (Git-backed, Markdown)
  - tmup SQLite DB (task DAG, events, messages, agents)
  - Structured journals (decision anchors, conductor state)
  - Findings store (exploratory issues, backpressure signals)
  - Enrichment outputs (BRIC artifacts, embeddings, metadata)
  - Memory layers (episodic memory, Pinecone indexes)
```

### 4.2 The Deacon (Persistent Daemon)

**What:** A systemd-managed daemon process. NOT an LLM agent. Deterministic state machine.

**Responsibilities:**
- Watch tmup SQLite DB for state changes (inotifywait + timer safety net)
- Detect when actionable work exists (completed tasks, failed tasks, idle workers, empty queue)
- Spawn Conductor sessions with appropriate context
- Monitor Conductor health (PID, timeout, crash recovery)
- Manage worker lifecycle (heartbeat monitoring, dead-claim recovery)
- Route backpressure signals into the findings store
- Maintain GUPP: "If there is work on your hook, it must run"

**Does NOT do:** Quality evaluation, code review, architectural decisions, natural language reasoning. All intelligence lives in the Conductor and Worker layers.

**Optional enhancement:** A small local model as a triage layer between the daemon and full Conductor sessions. Handles routine decisions (auto-advance passing CLEAR beads, simple retry dispatching) without spawning an expensive Opus session. Escalates to Opus when judgment is required.

### 4.3 The Conductor (Ephemeral Intelligence)

**What:** Ephemeral Claude Code CLI sessions (Opus model) spawned by the Deacon when intelligence is required.

**Session types:**
- **DISPATCH:** Read bead manifest, create tmup tasks, dispatch workers, write conductor journal entry, exit
- **EVALUATE:** Read completed work, evaluate quality, advance bead status or write correction directives, dispatch next round, update journal, exit
- **SYNTHESIZE:** Merge all outputs, run fitness checks, produce delivery summary, exit
- **RECOVER:** Handle stuck beads, exhausted retry budgets, escalation decisions, exit
- **DISCOVER:** Run scheduled audit/discovery beads, process exploratory issues, consolidate findings, exit

**State continuity:** The Conductor is ephemeral but contextually grounded. Before each session:
1. Read the conductor journal (structured + narrative decision anchors)
2. Read current bead state and tmup task state
3. Query episodic memory for relevant prior decisions
4. Read the findings store for active issues and backpressure signals

This reconstructs enough context for the Conductor to make informed decisions without needing persistent process state.

### 4.4 Workers (Task Executors)

**What:** Claude Code or Codex CLI sessions in tmux panes, executing individual beads.

**Two modes:**
- **Polecat (ephemeral):** Fresh worker per bead. Gets bead-context.md, executes, reports, exits. Default for CLEAR beads.
- **Crew (persistent):** Worker persists across multiple beads. The Conductor reprompts it with successive related beads, leveraging accumulated context. Used when dependency chains or file-scope overlap make context reuse valuable.

**Cross-model assignment:** The orchestrator assigns worker type based on task characteristics:
- Claude for planning, process control, complex multi-file coordination
- Codex for implementation, codebase-grounded analysis, cross-model review
- Either model for review loops (reviewer is not always the same model as author)

### 4.5 BRIC (Universal Enrichment Substrate)

**What:** A standing enrichment and context amplification service available across all workflow layers.

**Modes:**
- Daemon: always-on preprocessing and metadata extraction
- Evidence service: on-demand grounding for promotion/escalation decisions
- Delegated subprocessor: staged file/artifact processing with distilled output
- Backpressure clustering: turning operational noise into structured signals
- Compression loss mitigation: producing dense evidence bundles for handoffs

### 4.6 Memory and Retrieval Layers

- **Episodic memory:** Conversation history across sessions. Conductor queries for prior decisions, approaches tried, lessons learned.
- **Pinecone indexes:** Semantic search over codebase patterns, documentation, prior findings.
- **SQLite operational state:** tmup task DAG, event log, agent registry, backpressure signals.
- **Git-backed artifacts:** Bead files, journals, specs, decision traces. The durable long-term record.

---

## 5. The Self-Learning Loop

### 5.1 Continuous Recirculation

```
Work enters system (human-initiated or discovery-generated)
    ↓
Workers execute, producing artifacts + observations
    ↓
Observations captured: successes, failures, friction, anomalies
    ↓
Backpressure signals clustered, enriched (via BRIC), prioritized
    ↓
Findings consolidated: deduped, categorized, ranked, salience-tracked
    ↓
Promoted findings become new work (within scope)
    ↓
Exploratory issues route through escalation hierarchy
    ↓
Conductor journal updated with structured decision anchors
    ↓
Next pass starts with richer context than the previous one
```

### 5.2 What Gets Captured

**On success:**
- Pattern recognized
- Evidence used
- Action that resolved it
- Follow-on checks that proved valuable
- Scope assumptions that held

**On failure:**
- What was attempted
- Where reasoning broke down
- What evidence was missing
- What signals were misleading
- Which layer caught the problem
- Whether it reflects a recurring failure mode

**On backpressure:**
- Stuck tasks (count, duration, domain)
- Repeated retries on same issue
- Oscillating decisions
- Unresolved ambiguity patterns
- Recurring regressions
- Queue starvation periods
- Escalation frequency spikes
- Clusters of low-confidence findings
- Repeated human intervention dependency

### 5.3 Learning Without Self-Modification

The loop accumulates observations, failure modes, success cases, heuristics, evidence patterns, and enriched references. But:
- Changes to policy require machine-hierarchy adjudication
- Changes to thresholds require evidence from multiple passes
- Changes to promotion rules require higher-tier review
- Changes to autonomy boundaries require human approval

The system becomes better informed every pass without becoming self-rewriting in unsafe ways.

---

## 6. Cross-Model Collaboration Protocol

### 6.1 Artifact-Mediated Handoff

The default handoff between models is through the shared operational surface:

```
Claude executes "design" bead → writes design artifact
    ↓ (DAG dependency)
Codex executes "implement" bead → reads design artifact, writes implementation
    ↓ (DAG dependency)
Claude executes "review" bead → reads implementation, writes findings
    ↓ (if findings exist)
Codex executes "revision" bead → reads findings, applies fixes
```

The artifacts are the communication channel. The DAG handles sequencing. No model-to-model chat required.

### 6.2 Review Loop Protocol

```
Model A produces work product → artifact on shared surface
    ↓
Orchestrator routes to Model B for review
    ↓
Model B critiques/expands/validates → findings artifact
    ↓
If findings: route back to Model A (or Model C) for resolution
    ↓
If dispute: escalate to higher-tier adjudicator
    ↓
Iterate until convergence or escalation
```

Role assignment is dynamic: either model may author or review. The orchestrator decides based on task type, model strengths, and what's available.

### 6.3 Structured Decision Anchoring for Handoffs

Every cross-model handoff produces a decision anchor containing:

```yaml
handoff:
  from_model: claude-opus
  to_model: codex-cli
  artifact: beads/B04-codex-session-resume.md
  observed:
    - "Thread ID is already persisted via init event handler at session.ts:259"
    - "getResumableSessionForChat() returns session_id from agent_sessions table"
  inferred:
    - "B04a (DB persistence) was unnecessary as implementation but valuable as verification"
  changed:
    - "B04 approach updated: use DB value from getResumableSessionForChat(), not in-memory field"
  uncertain:
    - "Whether Codex app-server accepts stale thread IDs gracefully or errors"
  scope_assumed:
    - "session.ts crash recovery path only; no changes to runtime.ts"
  follow_on:
    - "Fallback test for rejected thread ID (oracle audit finding)"
```

---

## 7. The Proving Slice

### 7.1 What Gets Built First

The first implementation slice proves the core pattern — not a demo, but a reference loop that exercises the real protocol:

1. **Deacon daemon** — persistent systemd watcher on tmup SQLite, spawns Conductor sessions on state changes, monitors health, restarts on crash

2. **Conductor session lifecycle** — DISPATCH, EVALUATE, DISCOVER session types with structured journal read/write at session boundaries

3. **Structured conductor journal** — hybrid structured + narrative decision anchors, read at session start, appended at session end, Git-backed

4. **Cross-model dispatch** — Conductor dispatches Claude AND Codex workers via tmup, with artifact-mediated handoff through bead-context.md / bead-output.md

5. **Review loop** — at least one bead where Model A produces and Model B reviews, with findings routing back

6. **Finding store + clustering** — exploratory issues as first-class objects, basic deduplication and ranking

7. **Machine escalation path** — worker → conductor → orchestrator chain with structured escalation records before human notification

8. **BRIC integration** — at least one path where BRIC preprocesses a large file set and returns distilled artifacts for agent consumption

9. **Boundary suspicion** — agents can flag "this may be outside scope" and route it as an exploratory issue rather than autonomous action

10. **Adjacency + scheduled discovery** — completion-triggered adjacent inspection + at least one scheduled audit bead type

11. **Backpressure capture** — stuck tasks, retries, and failure patterns logged as structured signals and fed back into prioritization

### 7.2 What Gets Deferred

- Full BRIC daemon integration (proving slice uses BRIC as an on-demand service, not always-on daemon)
- Local model triage layer (start with direct Conductor spawning, add triage later)
- Full policy adjudication system (start with manual threshold management)
- Wasteland/federation concepts (single-machine first)
- The Refinery pattern for merge coordination (start with scope-isolated workers, add merge queue later)

---

## 8. Relationship to Existing Systems

### 8.1 Colony Runtime Spec (2026-04-03)

This spec supersedes the Colony Runtime design. The Deacon daemon, worker dispatch, and bridge concepts are preserved. The key changes:
- Conductor sessions gain explicit lifecycle types (DISPATCH, EVALUATE, DISCOVER, etc.)
- Structured conductor journal replaces implicit context loss
- Cross-model collaboration is a first-class protocol, not just worker-type selection
- Exploratory issues and backpressure capture are new first-class concepts
- BRIC integration is architectural, not incidental

### 8.2 SDLC-OS

The existing SDLC-OS bead system, loop mechanics (L0-L5), AQS, and oracle council are preserved. This spec extends them with:
- Persistent daemon layer for autonomous operation
- Cross-model handoff protocol
- Self-learning feedback loops
- Exploratory issue tracking

### 8.3 tmup

tmup remains the execution engine: SQLite WAL task DAG, tmux grid management, worker dispatch, harvest/reprompt. This spec adds:
- Colony-aware columns (already in tmup schema v4)
- Conductor journal as a new artifact type
- Findings store as a new operational surface

### 8.4 Gas Town Influences

| Gas Town Concept | Our Adaptation |
|-----------------|----------------|
| GUPP ("work on your hook, run it") | Deacon's tight polling loop ensures work never sits idle |
| Polecats (ephemeral workers) | Default worker mode for CLEAR beads |
| Crew (persistent workers) | Optional mode for dependency chains / file-scope overlap |
| Refinery (merge queue) | Deferred — scope-isolated workers first, merge coordination later |
| Witness (health patrol) | Deacon daemon + sentinel agents |
| NDI (nondeterministic idempotence) | Bead files + tmup state enable crash recovery and continuation |
| Beads as external memory | Preserved and extended with structured journals and findings |
| Seancing (session resurrection) | Conductor journal + episodic memory query at session start |
| Rule of Five (multi-pass review) | Oracle council + AQS + cross-model review loops |

---

## 9. Open Questions

1. **Local model triage:** What model is appropriate for the daemon triage layer? What's the decision boundary between "triage can handle this" and "spawn Opus"?

2. **BRIC operational model:** Is BRIC always-on (daemon) or on-demand (service)? What's its resource footprint?

3. **Conductor journal format:** Exact schema for structured decision anchors. How much narrative is enough without becoming lossy compression?

4. **Merge coordination timing:** When does the Refinery pattern become necessary? How many concurrent workers before merge conflicts become the bottleneck?

5. **Discovery budget:** How much agent time should go to discovery vs execution? Yegge says 40% for code health. What's right for us?

6. **Backpressure thresholds:** At what point does a stuck pattern trigger escalation vs continued retry? How many retries before a finding becomes "evidence about policy limits"?
