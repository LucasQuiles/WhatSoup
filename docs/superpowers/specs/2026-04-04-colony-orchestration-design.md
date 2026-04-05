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

## 9. Operational Model

### 9.1 The Runtime Loop

At runtime, the system behaves less like a queue runner and more like a layered operating loop.

A worker starts with an authorized mission and a bounded scope. It pulls the current task state, relevant artifacts, prior decisions, open findings, and enriched context from the shared operational record. It does not begin from a blank prompt. It begins from a live state bundle.

The worker executes within scope. While doing so, it continuously emits structured traces: what it observed, what it inferred, what it changed, what evidence it used, what failed, what remained uncertain, and what adjacent findings it noticed. Those traces are not just logs — they become reusable system objects.

If the worker finds follow-on work inside the same mission, it may enqueue or propose it directly according to policy. If it finds something outside scope, it creates an exploratory finding with evidence and sends it upward for machine adjudication.

A reviewer, peer agent, or higher-tier layer evaluates the output. This may be Claude reviewing Codex, Codex expanding Claude, BRIC enriching both, or a higher control layer reconciling conflicts. Every pass adds evidence, reduces ambiguity, or tightens action.

Meanwhile, daemon and enrichment layers run in the background: watching for stuck tasks, repeated retries, resurfacing issues, failed validations, noisy findings, and queue starvation. They also preprocess large inputs so workers reason over distilled evidence instead of raw bulk.

The loop:
1. **Act** — execute within scope
2. **Observe** — capture structured traces
3. **Capture evidence** — emit reusable system objects
4. **Cluster and enrich** — BRIC and background services process signals
5. **Promote, suppress, defer, or escalate** — orchestration decides
6. **Feed back into active state** — next pass starts richer

### 9.2 The Six Agent Needs

**1. Stable operating substrate.** Access to a shared operational record: active missions, scoped tasks, findings, prior decisions, evidence references, escalation history, enriched artifacts. Without this, every session resets and the design collapses into prompt theater.

**2. Explicit authority boundaries.** Every agent must know:
- What mission it is serving
- What scope it is allowed to modify
- What kinds of follow-on work it may promote automatically
- What must be raised as a finding instead
- What evidence threshold is required for action
- When to defer, suppress, duplicate-link, or escalate

This matters more than model selection. Most autonomous drift comes from unclear authority, not weak intelligence.

**3. Structured handoff formats.** Every meaningful transition preserves:
- Observation
- Inference
- Action taken
- Evidence
- Uncertainty
- Rejected alternatives
- Scope assumptions
- Next recommended step

Both machine-readable structure (for routing and clustering) and compact narrative (for nuance).

**4. Layered validation.** Agents do not trust their own outputs by default:
- Peer review by another model
- Evidence validation against file/line anchors
- Policy checks against mission/scope
- Regression or test checks
- Anomaly comparison against prior similar cases
- Confidence and ambiguity scoring

This reduces hallucinated autonomy without turning everything into human review.

**5. Memory that compounds.** Not generic chat memory — operational memory:
- Recurring failure modes
- Repeated successful remediations
- Common dead ends
- Common escalation triggers
- Codebase hotspots
- Issue clusters
- Tool selection patterns
- Evidence patterns that correlate with good or bad outcomes

New agents inherit this as working context, not rediscover it from scratch.

**6. Access to support services.** Agents offload to BRIC and similar systems:
- Large file-set preprocessing
- Corpus chunking
- Metadata enrichment
- Embeddings
- Entity extraction
- Line/file anchoring
- Anomaly surfacing
- Similarity matching to prior incidents
- Evidence bundling for handoff

Native to the workflow, not bolted on.

### 9.3 The Three Contracts

#### Agent Contract

Every agent receives at dispatch:
- Mission
- Scope (files, modules, packages authorized for modification)
- Allowed actions (implement, review, audit, discover)
- Required evidence threshold for action
- Handoff schema
- Escalation rules
- Available support services
- Current operational context bundle (state packet)

#### System Contract

The system provides:
- Shared operational record
- Finding/task/decision schemas
- Provenance and evidence anchors
- Review and validation paths
- Clustering and prioritization
- Suppression/deferral mechanisms
- Escalation hierarchy
- Enrichment hooks
- Backpressure capture

#### Control Contract

The system monitors:
- Drift (scope creep, unauthorized domain crossing)
- Retries (repeated retries without new evidence)
- Stuckness (repeated rewrites of same artifact)
- Unresolved ambiguity (low-confidence findings accumulating)
- Boundary suspicion (findings that look out-of-scope or novel)
- Escalation frequency (rising escalation rate)
- Issue resurfacing (same defects returning)
- Queue health (starvation, churn without resolution)
- Evidence quality (findings without anchors)
- Human intervention rate (repeated human involvement in same issue class)

These are not mere metrics. They are control inputs that feed back into routing, prioritization, and policy adjustment.

### 9.4 Boundary and Promotion Rules

#### Boundary Classification

Agents classify discoveries at two levels:
- **Mission boundary:** no longer part of the currently authorized campaign
- **Domain boundary:** materially different problem class, system area, or operational mode

Agents do not need perfect semantic classification. They need a way to say: *this looks adjacent, this looks novel, this looks out-of-scope, this looks risky.*

#### Promotion Criteria

Not every observation becomes work. Findings become executable tasks when they meet:
- Evidence quality threshold
- Relevance to active mission
- Similarity to known patterns
- Severity assessment
- Confidence level
- Available validation path
- Whether machine layers have already enriched or adjudicated it

Discovery is broad. Execution is narrow.

#### Suppression and Deferral

A healthy system also says:
- Keep visible, do not act yet
- Merge into existing issue
- Insufficient evidence — gather more
- Likely duplicate — link and consolidate
- Outside current campaign — defer
- Wait for stronger signal
- Human review eventually, not now

Without this, the queue becomes noise.

### 9.5 Learning Boundaries

The system continuously learns, but with a hard distinction:

**Allowed to change continuously:**
- More context
- Better retrieval patterns
- Better enrichment and clustering
- Stronger confidence on known patterns
- Improved evidence packaging
- More efficient routing heuristics

**Gated behind adjudication:**
- Policy changes
- Authority expansion
- Evidence threshold reduction
- Scope boundary redefinition
- Promotion rule changes
- Autonomy boundary modifications

The first category happens every pass. The second requires machine-hierarchy review and, for consequential changes, human approval.

### 9.6 Practical Operating Example

A Codex worker finishes a lint-fix mission in a package. During the work it notices repeated import-pattern anomalies in neighboring modules. It is allowed to create in-scope follow-on tasks for the same package because the mission allows local hygiene remediation.

It also notices a deeper database migration inconsistency outside the current package. It cannot act on that. It creates an exploratory finding with evidence. BRIC enriches the finding with file references, related migrations, and prior similar incidents. A higher-tier layer sees that this resembles an already known but unresolved issue cluster, links it, raises salience, and keeps it visible. No human is bothered yet.

Meanwhile, the daemon sees this is the fourth mission this week that surfaced similar migration anomalies. That is backpressure. It clusters those signals into a recurring pattern. A scheduled discovery bead is created for a higher-tier audit. That audit may later justify a new authorized campaign. That is self-learning without reckless self-expansion.

---

## 10. BRIC Integration Patterns

### 10.1 Scoped Workstream Identity

Every operational unit has a durable identity — not a random session ID, but a scoped workstream identity that serves as a correlation ID with operational semantics. The identity is a composite derived from:

- Repository
- Branch or worktree
- Mission/campaign ID
- Bead chain or task lineage
- Code area/package/module scope
- Issue cluster ID (if applicable)
- Time window / session epoch

Not necessarily encoded as one string, but conceptually this composite identity. It narrows retrieval and joins together: SQLite rows, artifact sets, transcript chunks, log events, vector entries, and enrichment outputs.

BRIC does not index raw sessions as monolithic blobs. It indexes state packets bound to durable scoped identities.

### 10.2 The State Ledger

The scoped workstream identity is paired with a **structured state ledger** in SQLite — a denormalized snapshot with pointers, not a full copy of all state and not just a pointer list.

The SQLite ledger stores:

| Field | What it contains |
|-------|-----------------|
| Slug ID | Scoped workstream identity (composite key) |
| Mission ID | Active mission reference |
| Current authorized scope | Files, modules, packages agent may modify |
| Active beads and statuses | Bead IDs with current lifecycle state |
| Latest commit hash / branch / diff summary | Git state snapshot |
| Changed files / hotspots | Files modified in this workstream |
| Linked artifacts | Pointers to work product files |
| Linked findings / issues | Pointers to exploratory issues and open findings |
| Decision anchors | Structured + narrative records of key decisions |
| Unresolved questions | Explicit uncertainty tracking |
| Provenance pointers | References into Git objects, artifact files, vector entries |
| Last enrichment timestamps | When BRIC last processed this workstream |
| Vector store references | Entry IDs for associated semantic records |

This is the compact structured snapshot that enables a **coordinated rehydration flow** — not a single database call, but an orchestrated sequence:

1. SQLite query for structured state and pointers
2. Artifact resolution via provenance pointers
3. Bead state read from Git-backed files
4. Optional vector expansion for semantic context widening

The important part is orchestration, not one lookup.

### 10.3 The State Packet

A state packet is the operational context bundle assembled for an agent at session start. It is constructed from the state ledger plus enriched context:

| Field | Source | Authority |
|-------|--------|-----------|
| Mission ID | Orchestrator | Authoritative |
| Workstream identity | Composite key | Authoritative |
| Current authorized scope | Mission definition | Authoritative |
| Active beads and status | Bead files (Git) | Authoritative |
| Commit hash / branch / diff summary | Git | Authoritative |
| Changed files and hotspots | BRIC preprocessing | Enrichment |
| Linked findings/issues | Findings store | Authoritative |
| Evidence anchors: file paths, line ranges, artifact IDs | BRIC + Git | Mixed |
| Relevant transcript extracts | BRIC post-hook | Enrichment |
| Tool log summary | BRIC post-hook | Enrichment |
| Unresolved questions | Conductor journal | Authoritative |
| Rejected paths | Conductor journal | Authoritative |
| Confidence/ambiguity markers | Prior evaluations | Enrichment |
| Next recommended actions | Conductor journal | Advisory |
| Promotion/escalation state | Orchestrator | Authoritative |

Authoritative fields are ground truth. Enrichment fields support reasoning but are not definitive.

### 10.4 Four-Layer Storage Model

Each layer serves a distinct purpose, ordered by authority and confidence — not recency:

| Layer | What it stores | Authority | Retrieval mode |
|-------|---------------|-----------|----------------|
| **Beads** (Git) | Workflow-authoritative execution state: objectives, status, corrections, decisions | Ground truth | Deterministic file read |
| **Artifacts** (Git + filesystem) | Authoritative work products and human-readable outputs | Ground truth | Deterministic file read |
| **SQLite** (tmup DB + state ledger) | Authoritative structured operational continuity: provenance, linkages, task lifecycle | Structured truth | Deterministic query |
| **Vector storage** (Pinecone + embeddings) | Non-authoritative semantic recall and related-context surfacing | Approximate recall | Constrained semantic search |

Vector storage is not fourth because it is old. It is fourth because it is probabilistic. The retrieval rule:

1. Use deterministic scoped state first (beads, ledger)
2. Use linked artifacts and provenance second
3. Use SQLite for structured joins and continuity
4. Use vector recall to widen or recover context when deterministic state is insufficient

The system resists compression loss by preserving state across multiple complementary layers. BRIC plus SQLite plus scoped identity improves handoff fidelity, retrieval precision, and context reconstruction efficiency. It does not eliminate loss — it reduces it through layered redundancy.

### 10.5 Typed Event Model

BRIC operates on typed events, not raw "session stuff." Without a typed event model, BRIC becomes a garbage sink.

#### Event Types

| Event | Trigger | BRIC Processing Level |
|-------|---------|----------------------|
| `bead_started` | Worker begins bead execution | Full enrichment |
| `bead_completed` | Worker reports completion | Full enrichment |
| `bead_failed` | Worker reports failure | Full enrichment |
| `commit_created` | Git commit lands | Full enrichment |
| `test_run_completed` | Test suite finishes | Full enrichment |
| `patch_applied` | Diff applied to working tree | Full enrichment |
| `escalation_requested` | Agent requests escalation | Full enrichment |
| `finding_opened` | Agent creates exploratory finding | Full enrichment |
| `finding_promoted` | Finding becomes executable task | Full enrichment |
| `finding_deferred` | Finding deferred for later | Batched condensation |
| `session_checkpointed` | Conductor saves state | Full enrichment |
| `large_file_batch_read` | Agent reads many files | Batched condensation |
| `notable_tool_failure` | Tool error with signal value | Batched condensation |
| `retry_pattern_detected` | Same action retried 3+ times | Batched condensation |
| `shell_command_executed` | Individual CLI invocation | Append-only logging |
| `trivial_file_read` | Single small file read | Append-only logging |
| `intermediate_tool_chatter` | Low-signal tool output | Append-only logging |

#### Three Processing Modes

- **Full enrichment:** Extract events, compute embeddings, update SQLite ledger, update vector store, produce distilled artifacts. Triggered by high-value events.
- **Batched condensation:** Append to raw event log. Periodically (or on next full-enrichment trigger), batch-process accumulated medium-value events. Extract patterns without per-event overhead.
- **Append-only logging:** Write to JSONL stream. No immediate processing. Available for retrospective analysis and backpressure detection. Keeps hook overhead near zero for low-value events.

### 10.6 BRIC Output Types

BRIC produces multiple typed outputs, not a single summary blob:

**A. Structured state updates** (written to SQLite ledger):
- Decision records
- Finding records
- Linkage updates
- Bead/session status deltas
- Provenance pointers
- Ambiguity/confidence markers

**B. Distilled retrieval artifacts** (stored as JSON files):
- Context packets for agent consumption
- Evidence bundles for escalation/adjudication
- Diff summaries and hotspot maps
- Unresolved-question sets
- Clustering outputs (related failures, similar patterns)

**C. Vectorizable summaries** (written to vector store):
- Scoped semantic summaries
- Decision summaries
- Failure pattern summaries
- Artifact abstracts
- Transcript extracts with metadata

**D. Optional human-readable summaries** (written as markdown):
- Checkpoint reports
- Review packets
- Escalation briefs

### 10.7 BRIC Lifecycle Roles

#### Pre-Hook Context Assembler

Before an agent begins work on a bead:
- Receives: current diff, HEAD commit, branch, active mission, active bead list, open findings, recent tool logs, prior state packet
- Resolves related artifacts, extracts relevant code regions, attaches related prior issues
- Computes embeddings, clusters nearby signals
- Returns a distilled context packet
- The agent starts from the packet, not from raw scattered state

#### Post-Hook State Condenser

After a bead completes:
- Receives: updated diff, new logs, transcript excerpt, test results, changed files, produced artifacts
- Extracts decisions, unresolved uncertainties, evidence anchors, follow-on findings, candidate duplicates
- Updates the persistent state ledger, retrieval index, SQLite state, and linked vector entries
- The next worker inherits a structured continuation, not a lossy prose handoff

#### BRIC Preprocessing Contract

BRIC does not ingest raw material blindly. For every input source it must:
1. **Extract structured events** from noisy streams
2. **Identify decision points and unresolved ambiguity**
3. **Attach provenance** (file, line, commit, timestamp)
4. **Discard low-value repetition**

Raw transcripts are noisy. Tool logs are noisy. JSONL must be normalized. Without filtering, the system builds an expensive memory swamp.

#### Background Utility Worker

Continuously running:
- Monitor for stuck work, repeated retries, unresolved findings, and resurfacing patterns
- Cluster similar failures
- Refresh salience on active issue families
- Reindex changed artifacts and transcripts
- Maintain the retrieval graph

#### Evidence Service for Adjudication

When a higher-tier agent decides whether to promote, suppress, merge, or escalate:
- BRIC provides a scoped evidence bundle instead of raw history
- Includes: file references, related cases, prior similar incidents, anomaly summaries, confidence assessment

### 10.8 BRIC Safety Boundary

BRIC enriches and stages, but does not become the policy engine. It can help write decision-tree entries, classify patterns, and propose linkages. But promotion rules, authority expansion, and policy mutation live in the orchestration/guardrail layer. Moving control into an enrichment service undermines the layered mediation model.

### 10.9 What This Design Actually Is

BRIC is not a magic memory layer. It is a hook-integrated enrichment and condensation service. It passively captures high-value operational signals, converts them into structured state updates and distilled retrieval artifacts, and binds them to a durable scoped workstream identity. SQLite provides deterministic continuity and joins. Artifacts preserve human/machine-readable work products. Vector storage provides semantic recall inside the correct operational neighborhood. Together these layers improve handoff fidelity and reduce the need to reconstruct context from scratch. They do not eliminate loss — they reduce it through layered redundancy, structured capture, and orchestrated rehydration.

---

## 11. Schema Discipline

### 11.1 Event Schema

All typed events share a common envelope:

```
event_id:         TEXT PRIMARY KEY (ULID — sortable, unique)
event_type:       TEXT NOT NULL (from typed event enum)
workstream_id:    TEXT NOT NULL (scoped workstream identity)
bead_id:          TEXT (nullable — not all events are bead-scoped)
agent_id:         TEXT (nullable — daemon events have no agent)
timestamp:        TEXT NOT NULL (ISO 8601)
payload:          TEXT NOT NULL (JSON — schema varies by event_type)
processing_level: TEXT NOT NULL DEFAULT 'pending' 
                  CHECK (processing_level IN ('pending','logged','condensed','enriched'))
idempotency_key:  TEXT UNIQUE (event_type + workstream_id + bead_id + content_hash)
```

**Versioning:** Each event_type has a `schema_version` field inside its JSON payload. Consumers check version before processing. Unknown versions are logged and skipped, not rejected.

**Idempotency:** The `idempotency_key` prevents duplicate processing. If a hook fires twice for the same underlying change, the second insert is a no-op (INSERT OR IGNORE).

**Partial write / retry:** Events are written in a single INSERT. If the write fails, the hook retries once. If it fails again, the event is written to a fallback JSONL file (`events-fallback.jsonl`) for recovery during the next Deacon cycle.

### 11.2 State Ledger Schema

```
workstream_id:      TEXT PRIMARY KEY
repo:               TEXT NOT NULL
branch:             TEXT NOT NULL
mission_id:         TEXT NOT NULL
scope_region:       TEXT (package/module path pattern)
bead_lineage:       TEXT (JSON array of bead IDs in chain)
active_beads:       TEXT NOT NULL (JSON: {bead_id: status})
latest_commit:      TEXT
diff_summary:       TEXT
changed_files:      TEXT (JSON array)
hotspots:           TEXT (JSON array)
linked_artifacts:   TEXT (JSON array of {path, type, checksum})
linked_findings:    TEXT (JSON array of finding IDs)
decision_anchors:   TEXT (JSON array of structured anchor objects)
unresolved:         TEXT (JSON array of question strings)
provenance:         TEXT (JSON: pointers to Git objects, artifact files, vector IDs)
last_enriched_at:   TEXT (ISO 8601)
vector_refs:        TEXT (JSON array of vector entry IDs)
schema_version:     INTEGER NOT NULL DEFAULT 1
created_at:         TEXT NOT NULL
updated_at:         TEXT NOT NULL
```

**Versioning:** `schema_version` field on each row. Migrations are additive (new nullable columns). Old rows are upgraded on first read.

**Dedupe:** `workstream_id` is the primary key. Upserts use `INSERT OR REPLACE`. No duplicate workstreams.

### 11.3 Finding Schema

```
finding_id:       TEXT PRIMARY KEY (ULID)
workstream_id:    TEXT NOT NULL
source_bead_id:   TEXT (nullable)
source_agent_id:  TEXT
finding_type:     TEXT NOT NULL CHECK (finding_type IN 
                  ('in_scope','exploratory','boundary_crossing','backpressure','duplicate_candidate'))
evidence:         TEXT NOT NULL (JSON: observations, file refs, line ranges)
confidence:       REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0)
affected_scope:   TEXT (package/module/file pattern)
suspected_domain: TEXT
related_findings: TEXT (JSON array of finding IDs)
suggested_actions: TEXT (JSON array)
promotion_state:  TEXT NOT NULL DEFAULT 'open' CHECK (promotion_state IN 
                  ('open','promoted','deferred','suppressed','merged','escalated','archived'))
suppression_reason: TEXT (nullable — required when suppressed or deferred)
salience:         REAL NOT NULL DEFAULT 1.0 CHECK (salience BETWEEN 0.0 AND 1.0)
created_at:       TEXT NOT NULL
updated_at:       TEXT NOT NULL
resolved_at:      TEXT
schema_version:   INTEGER NOT NULL DEFAULT 1
```

### 11.4 Write Serialization Strategy

SQLite WAL allows one writer at a time. With Deacon, Bridge, and BRIC all writing to events.db, contention is inevitable under load. The mitigation strategy:

**events.db writes are funneled through the Deacon process.** Other components do not write directly to events.db. Instead:
- Bridge emits events to a JSONL append file (`events-inbox.jsonl`) — atomic append, no lock contention
- BRIC writes enrichment results to a JSONL append file (`enrichment-inbox.jsonl`)
- The Deacon's maintenance loop (every 60s) batch-ingests from both inbox files into events.db as a single writer
- High-value events that need immediate visibility (bead_completed, bead_failed) are written by the Deacon directly when it detects them via inotifywait on tmup.db

**tmup.db contention is managed by existing WAL + busy_timeout=8000.** This is acceptable because tmup writes are short (single-row INSERT/UPDATE) and the existing 8-agent concurrency model has been tested with 698 tests.

**Fallback:** If events.db becomes locked during the Deacon's batch ingest (e.g., concurrent schema migration), the Deacon retries after one WAL checkpoint cycle. If it fails 3 times, it logs a warning and continues — the inbox files serve as a durable buffer.

### 11.5 Migration Strategy

- All schema changes are additive: new columns with defaults, new tables, new indexes
- Never drop or rename columns in production
- Migration scripts live in `colony/migrations/` with sequential numbering
- Each migration is idempotent (re-running is safe)
- Schema version tracked in `schema_meta` table

---

## 12. Conflict Reconciliation

When layers disagree:

| Conflict | Resolution Rule |
|----------|----------------|
| Bead says status X, SQLite says status Y | **Bead wins.** Bead files are the authoritative execution record. SQLite is updated to match. Log the discrepancy. |
| Artifact content differs from bead description | **Artifact wins** for content (it's the work product). Bead wins for status and scope. |
| SQLite ledger has stale commit hash | **Git wins.** Refresh the ledger from actual Git state. |
| Vector recall contradicts current bead state | **Bead wins.** Vector recall is advisory. Flag the stale vector entry for reindexing. |
| Two findings claim to be the same issue | **Merge conservatively.** Keep both with a `duplicate_candidate` link. Machine adjudication or human review decides which survives. |
| Decision anchor in journal conflicts with bead correction history | **Bead correction history wins.** It is the accumulator. Journal is advisory context. |

**General rule:** When in doubt, the more structured and proximate source wins. Beads > SQLite > artifacts > vector recall. Discrepancies are logged as reconciliation events and trigger ledger refresh.

---

## 13. State Lifecycle and Garbage Collection

### 13.1 Workstream Lifecycle

```
active → completing → archived → (optionally) purged

active:     beads executing, findings open, ledger updating
completing: all beads terminal, final synthesize pass running
archived:   ledger frozen, findings resolved or deferred, vector entries retained
purged:     SQLite rows deleted, vector entries removed, only Git artifacts remain
```

### 13.2 Retention Rules

| What | Active retention | Archive trigger | Purge trigger |
|------|-----------------|-----------------|---------------|
| State ledger rows | Indefinite while workstream active | Workstream completes + 7 days | 90 days after archive |
| Event rows | 30 days | Older events → batched condensation, then delete originals | Condensed summaries retained 90 days |
| Finding records | Indefinite while open | Finding resolved/archived | 90 days after resolution |
| Vector entries | Indefinite while workstream active | Superseded by newer entry for same scope | 90 days after supersession |
| Fallback JSONL | Until successfully replayed | Replay succeeds | Immediate after replay |
| BRIC distilled artifacts | Indefinite while workstream active | Workstream archives | 30 days after archive |

### 13.3 Salience Decay

Active findings have a salience score. Salience decays when:
- No new evidence is added for 7 days (score *= 0.8)
- Related workstreams complete without referencing the finding (score *= 0.7)
- Finding is explicitly deferred (score = 0.1, held at floor)

Findings below salience 0.05 are auto-archived (not deleted — archived with full history).

### 13.4 Ledger Forking

When a workstream spawns a sub-workstream (e.g., a discovery finding becomes a new campaign):
- New workstream gets a fresh ledger
- Parent workstream links to child via `provenance` field
- Child inherits relevant decision anchors and findings by reference (pointers, not copies)
- Parent and child evolve independently

---

## 14. Promotion and Suppression Policy

### 14.1 Automatic Promotion (finding → executable task)

A finding is auto-promoted when ALL of:
- `finding_type` is `in_scope`
- `confidence` >= 0.7
- Evidence includes at least one file/line anchor
- No conflicting open finding exists for the same scope
- The finding pattern matches a known-successful remediation pattern (Phase 2+; relaxed during cold-start — first 10 workstreams skip this check)
- Active mission allows follow-on work in the affected scope

### 14.2 Machine Adjudication Required

A finding requires machine adjudication when ANY of:
- `finding_type` is `exploratory` or `boundary_crossing`
- `confidence` < 0.7 but > 0.3
- Evidence is indirect (inference, not direct observation)
- Affected scope overlaps with another agent's active bead
- The finding pattern is novel (no prior match in operational memory)

Machine adjudication flow: BRIC enriches → lower-tier agent classifies → higher-tier agent decides (promote / defer / suppress / merge / escalate).

### 14.3 Suppression Rules

A finding is suppressed when ANY of:
- Duplicate of an already-promoted task (linked, not deleted)
- Below confidence 0.3 with no corroborating evidence
- Outside all active missions AND no severity indicator
- Explicitly marked by a higher-tier agent as noise

Suppressed findings are retained with `suppression_reason`. They can be resurfaced if new corroborating evidence appears.

### 14.4 Human Escalation Threshold

A finding reaches human escalation when ALL of:
- Machine adjudication was attempted (at least 2 tiers)
- No tier could safely resolve (insufficient evidence, novel domain, policy ambiguity)
- Severity is non-trivial (not a minor code style observation)
- OR: the same pattern has been escalated to machine adjudication 3+ times without resolution

---

## 15. Backpressure Response Behavior

Backpressure is not just a signal — it triggers concrete control actions:

| Signal | Threshold | Response |
|--------|-----------|----------|
| Task stuck (same bead, repeated retries) | 3 retries without new evidence | Pause retries. Route to higher-tier agent for diagnosis. Increase evidence threshold for next attempt. |
| Oscillating state (bead bouncing between states) | 3 round-trips | Freeze bead. Create diagnostic finding. Escalate to Conductor. |
| Rising escalation rate | >50% of findings escalating in one cycle | Slow promotion rate. Increase BRIC enrichment depth. Trigger scheduled discovery audit of the affected scope. |
| Queue starvation | No pending work for >30 minutes while agents are idle | Trigger scheduled discovery beads. Notify human if no discoverable work exists. |
| Repeated human intervention on same class | Same issue type escalated to human 3+ times | Create a policy review finding. Flag as recurring pattern. Machine layers should attempt automated resolution next time. |
| Low-confidence finding accumulation | >10 open findings below confidence 0.5 | Trigger BRIC clustering pass. Merge duplicates. Suppress noise. Raise evidence bar for new findings in that scope. |
| Review loop disagreement | Same bead rejected by reviewer 3+ times | Escalate to higher-tier adjudicator. If still unresolved, freeze and escalate to human. |

---

## 16. Failure Containment and Degraded Modes

### 16.1 Component Failure Matrix

| Component down | Impact | Degraded mode |
|---------------|--------|---------------|
| **BRIC unavailable** | No pre-hook enrichment, no post-hook condensation | Agents rehydrate from SQLite ledger + bead files + artifacts only. No vector updates. Append-only logging continues to fallback JSONL. Work continues with reduced context quality. |
| **SQLite locked/corrupted** | No state ledger, no event writes | CRITICAL. Deacon detects via health check. All workers paused. Deacon attempts WAL recovery. If unrecoverable, alert human. Bead files (Git) are the recovery point. |
| **Vector indexing lagging** | Stale semantic recall | Agents get current deterministic state but older vector context. Flag as degraded in state packet. Work continues. |
| **Event hooks failing** | Events not captured | Fallback to JSONL append. Deacon batch-replays on recovery. No immediate data loss, but real-time enrichment paused. |
| **BRIC produces nonsense** | Bad enrichment artifacts | Enrichment fields are advisory, not authoritative. Agents fall back to deterministic state. Bad artifacts flagged and quarantined. BRIC processing paused for review. |
| **Review loops disagree repeatedly** | Bead cannot advance | Freeze after 3 cycles. Escalate to higher tier, then human. Bead marked `stuck` with full disagreement history. |
| **Task oscillating between states** | Wasted compute | Freeze after 3 round-trips. Diagnostic finding created. No further retries until root cause addressed. |

### 16.2 General Degradation Principle

The system degrades by shedding enrichment layers while preserving authoritative state:

```
Full mode:    beads + artifacts + SQLite + BRIC enrichment + vector recall
Reduced:      beads + artifacts + SQLite + append-only logging
Minimal:      beads + artifacts + Git history only
Emergency:    bead files in Git (the last resort recovery point)
```

Each level sheds the least-authoritative layer first. Work can continue at every level above emergency, with progressively reduced context quality.

---

## 17. Cost and Throughput Budgets

| Resource | Budget | Enforcement |
|----------|--------|-------------|
| Hook frequency (high-value events) | Max 60/hour per workstream | Event deduplication + rate limiter in hook runner |
| Hook frequency (medium-value events) | Batched every 5 minutes | Timer-based condensation, not per-event |
| BRIC enrichment concurrency | Max 2 concurrent enrichment runs | Semaphore in Deacon |
| Vector indexing batch size | Max 50 records per batch | Batched writes to Pinecone |
| Review loop depth | Max 3 cycles per bead per loop level | Hard limit in Conductor policy |
| Max retries per bead | 3 at L0, 2 at L1, 2 at L2 | tmup task retry config |
| Per-workstream cost ceiling | $50 USD (configurable) | Deacon tracks cumulative cost from Conductor session outputs |
| Per-agent context assembly | Max 100K tokens per state packet | BRIC truncates and summarizes above limit |
| Conductor session timeout | 30 min (DISPATCH/EVALUATE), 60 min (SYNTHESIZE) | Deacon SIGTERM + SIGKILL |
| Worker session timeout | Calibrated by Cynefin: CLEAR=5min, COMPLICATED=15min, COMPLEX=30min | tmup heartbeat + dead-claim recovery |
| Discovery budget | Max 20% of total workstream compute | Deacon tracks discovery vs execution bead ratio |
| Findings store max open | 100 open findings per workstream | Auto-archive lowest-salience findings above limit |

---

## 18. Security and Privacy Boundaries

### 18.1 Storage Rules

| Content type | May store verbatim | Must summarize | Must redact |
|-------------|-------------------|----------------|-------------|
| Source code diffs | Yes (in artifacts, Git) | N/A | Strip credentials if detected |
| Bead files | Yes | N/A | No secrets in bead fields |
| Decision anchors | Yes (structured + narrative) | N/A | No credential references |
| Transcripts | Extracts only (not full transcripts) | Full transcripts → BRIC summary | Strip API keys, tokens, passwords |
| Tool logs | Yes (in append-only JSONL) | N/A | Strip environment variables containing secrets |
| Test output | Yes (in artifacts) | N/A | Strip connection strings |
| Vector summaries | Yes (semantic summaries) | Full content → embedding + abstract | No raw credentials in vector metadata |

### 18.2 Retention Limits

| Store | Max retention |
|-------|---------------|
| Append-only event JSONL | 30 days (then condense or purge) |
| SQLite state ledger | 90 days after workstream archive |
| Vector entries | 90 days after supersession |
| BRIC distilled artifacts | 30 days after workstream archive |
| Git-backed artifacts (beads, specs) | Indefinite (Git history) |

### 18.3 Access Rules

- Only agents dispatched within a workstream may read that workstream's state packet
- BRIC may read any workstream for cross-workstream clustering (read-only)
- The Deacon may read all workstreams for health monitoring (read-only)
- Human has full access to all stores

---

## 19. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Handoff reconstruction accuracy | >80% of decision anchors recoverable by fresh Conductor | Sample 10 handoffs, measure anchor recovery rate |
| Repeated context rebuild reduction | >50% reduction vs baseline (no ledger/BRIC) | Compare context assembly time and completeness with/without system |
| In-scope follow-on task generation precision | >70% of auto-promoted tasks are valid and useful | Sample promoted tasks, measure human agreement rate |
| Exploratory finding false positive rate | <30% of exploratory findings are noise | Sample findings, measure suppression rate after adjudication |
| Escalation precision | >80% of human escalations are genuinely needed | Track human action rate on escalated items |
| Stuck-task recovery rate | >90% of stuck tasks recovered without human intervention | Track stuck → resolved without human touch |
| Duplicate-finding merge quality | >80% of merge proposals are correct | Sample merged findings, measure split rate |
| Retrieval usefulness by layer | Each layer contributes to >50% of state packets | Track which layers are actually consulted in rehydration |
| Human interruption reduction | >60% reduction in human escalations per workstream over 30 days | Compare escalation rate week 1 vs week 4 |
| System cost per workstream | <$50 USD average per completed workstream | Track from Conductor session cost outputs |

---

## 20. Reference Paths

### 20.1 Golden Path

```
1. Codex worker completes implementation bead
2. Post-hook emits bead_completed event (typed, high-value)
3. BRIC receives: diff, commit hash, transcript extract, test results, changed files
4. BRIC condenses: extracts decisions, evidence anchors, follow-on findings
5. BRIC updates: SQLite state ledger, vector store, distilled artifact
6. Worker reports adjacent finding: "import anomaly in neighboring module"
7. Finding created: in_scope, confidence 0.8, evidence includes file refs
8. Auto-promotion check: in_scope + confidence >= 0.7 + file anchor + active mission allows → PROMOTED
9. Orchestrator creates follow-on bead from promoted finding
10. Claude worker receives next bead with full state packet (assembled from ledger + artifacts + beads)
11. Claude reviews promoted task, implements fix
12. Post-hook captures second bead_completed event
13. Cycle continues
```

### 20.2 Degraded Path (BRIC Unavailable)

```
1. Codex worker completes implementation bead
2. Post-hook emits bead_completed event
3. BRIC is down — event falls back to append-only JSONL
4. Minimal SQLite update: bead status change, commit hash, changed files (from Git directly)
5. No vector update, no enrichment artifacts
6. Worker reports adjacent finding (same as golden path)
7. Finding created with lower enrichment: no BRIC clustering, no related-case matching
8. Auto-promotion check: passes on evidence quality alone (file refs present)
9. Orchestrator creates follow-on bead
10. Claude receives state packet assembled from ledger + artifacts only (no BRIC enrichment)
11. State packet flagged: "degraded — BRIC offline, reduced context quality"
12. Claude proceeds with reduced but functional context
13. When BRIC recovers: Deacon triggers batch replay of JSONL backlog
14. Enrichment catches up, vector store updated, ledger refreshed
```

### 20.3 Failure Path (Review Loop Disagreement)

```
1. Claude reviews Codex implementation, finds issues
2. Codex revises based on findings
3. Claude reviews again, finds different issues
4. Codex revises again
5. Claude reviews third time — still disagrees (3 cycles exhausted)
6. Bead frozen with status: stuck
7. Full disagreement history preserved in bead corrections
8. Escalation to higher-tier adjudicator (Opus)
9. If adjudicator resolves: bead unfreezes, work continues
10. If adjudicator cannot resolve: human escalation with full evidence bundle
11. Human decides, resolution recorded as decision anchor
12. Pattern recorded in operational memory for future similar cases
```

---

## 21. Open Questions

1. **Local model triage:** What model is appropriate for the daemon triage layer? What's the decision boundary between "triage can handle this" and "spawn Opus"?

2. **Merge coordination timing:** When does the Refinery pattern become necessary? How many concurrent workers before merge conflicts become the bottleneck?

3. **Discovery budget calibration:** 20% cap is a starting point. How do we measure whether discovery is producing value vs noise?

4. **Cross-workstream learning:** When should operational memory from one workstream inform another? What's the contamination risk?

5. **BRIC cold start:** How does the system bootstrap when there's no prior operational memory? What's the minimum viable state packet for the first workstream?
