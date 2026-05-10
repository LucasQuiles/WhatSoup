# Protection Layer Verification Bank

**Status:** pending

**Disposition:** Captured review protocol. Execution of this bank requires explicit authorization (gate #7 in `OPEN-ITEMS.md`).

**Capture context (2026-05-10):** This bank was authored against the long-branch protection-layer plan, which predates `dffc127 chore(whatsoup-guard): remove dead event kinds`. Sections D, E, and H reference architecture (for example, `EventKind` enum values, `src/watchdog/index.ts`, `runChannelChain`) that may not match current `tools/whatsoup_guard/` on origin/main. Reconciliation against the cleaned design is required before bank execution; expected mismatches in section D Q46 and section H Q117 are baseline drift, not gaps.

---

**Subject of review:** the protection-layer implementation plan at `docs/plans/2026-05-08-whatsoup-protection-layer-implementation-plan.md`.

**Provenance:** captured 2026-05-10. Originally titled "120-question verification bank" but contains 320 questions across 20 sections, A–T.

**Purpose:** append-to-plan-review-prompt checklist, evidence-based. Each question requires first-hand evidence; no PASS may be accepted without file paths, line ranges, function/class/export/test names, command runs, output summaries, exact plan section/task affected, required plan revision, and follow-up owner.

## How this artifact is used

- **Subject of review:** the long-branch protection-layer implementation plan at `docs/plans/2026-05-08-whatsoup-protection-layer-implementation-plan.md` (lives only on `feature/whatsoup-protection-layer`, not on `origin/main`; predecessor draft also exists in main-worktree dirty WIP).
- **Companion subject:** `tools/whatsoup_guard/` package now on `origin/main` (PR #197 squash `8d739e7`); inventory at `codebase-snapshot/wave-1-surfaces/07-tools-whatsoup-guard.md`.
- **Mode:** read-only, evidence-gated review. No code changes from running this bank — only findings, plan-revision requirements, and follow-up assignments.
- **Dispatch model:** disposable sub-agents per section (Gas Town / SDLC-OS), durable artifacts under this audit directory. No agent inherits another's memory; every claim links back to source.
- **Reject criteria:** any "PASS" without file path, line numbers, function names, command output, and plan-section-affected. Words like "appears", "probably", "seems", "should" without evidence are auto-rejected.
- **Never executed in this session.** Capturing only. Future review passes consume this checklist.

## Mandatory answer format

```text
Question ID:
Verdict: PASS / FAIL / PARTIAL / INCONCLUSIVE
Evidence:
- File path:
- Line range:
- Function/class/export/test name:
- Command run:
- Output summary:
- Exact plan section/task affected:
- Required plan revision:
- Follow-up owner:
```

---

## A. Repository, branch, and release-state sanity checks

1. What exact branch/worktree is being reviewed, and does it match the branch named in the plan?
2. What is the exact `HEAD` SHA, merge-base SHA, and commit count ahead/behind `main` and `origin/main`?
3. Is the feature branch local-only, or does it have an upstream remote branch?
4. Has CI actually run on the reviewed SHA, or are all green results local-only?
5. Are there uncommitted files that affect the reviewed behavior, including ignored artifacts, docs, `.gitignore`, package files, lockfiles, or generated evidence?
6. Are the spec, parent implementation plan, integration plan, playbook, kickoff instructions, and orchestration notes all tracked in the same branch history as the code?
7. Does `.gitignore` allow all intended public plan/spec docs to be committed without allowing private or local-only artifacts?
8. Are any evidence artifacts required by the plan ignored, missing, stale, or not reproducible?
9. Does `git diff --check` pass across all modified files?
10. Does the repository contain generated artifacts that are required for correctness but excluded from source control?
11. Do root-level tests fail? If yes, which failures are pre-existing on `main`, and which are caused by this branch?
12. Does the package-local test suite passing prove release readiness, or only package-local correctness?
13. Are there root launcher, script, or policy tests that the guard package bypasses?
14. Are any commands in the plan using a different runtime from what CI or production will use?
15. Does the plan clearly separate "local package green," "root green," "remote CI green," and "merge-ready"?

## B. Spec-to-plan-to-code traceability

16. For every MUST/SHALL requirement in the source spec, which task implements it, which files contain it, and which tests prove it?
17. Are any plan tasks marked complete without a corresponding code change, test, and verification artifact?
18. Are any spec requirements implemented but not mentioned in the plan, creating undocumented behavior?
19. Are any plan requirements implemented in tests only, not production code?
20. Are any requirements implemented only in simulator paths but not real runtime paths?
21. Are any "out of scope" items referenced by production code as if they exist?
22. Are any "future follow-up" capabilities already partly represented in enums, schemas, docs, or CLI commands, creating false confidence?
23. Are all first-pass integration gaps explicitly mapped to closed code paths, not just emitted events?
24. Did the integration plan close "event written" only, or did it also prove "event consumed and drives behavior"?
25. Does every acceptance scenario in the plan have an end-to-end test that would fail if the runtime wiring were removed?
26. Does the plan now explain the difference between unit proof, integration proof, simulator proof, and production-realistic proof?
27. Are any plan checkboxes satisfied by mocked dependencies in a way that hides missing runtime wiring?
28. Does the plan include a "negative proof" section showing what is intentionally not implemented?
29. Are deferred items explicitly labeled as deferred, with no active code pretending they are live?
30. Is there any stale "ready to merge," "release green," or "complete" wording contradicted by current blockers?

## C. Head-to-toe runtime flow

31. Starting from the CLI entrypoint, what exact function chain runs a normal guard cycle?
32. What are the entrypoints for `ping`, `cycle`, `mute`, `status`, and `simulate`, and which ones call production runtime code versus test/simulator code?
33. Does `cycle` execute real collectors, policy loading, baseline checks, evaluators, suppression, formatting, sinks, ledger writes, and exit-code logic?
34. Where is `runCycle` defined, and what are all of its side effects?
35. Where is `runOneProbe` defined, and what does it do when baseline is missing, corrupt, stale, or valid?
36. What exact condition determines whether a cycle is "actionable"?
37. Does "actionable" include drift, probe errors, self-protection failures, baseline integrity failures, delivery failures, watchdog findings, and policy action violations?
38. What code decides the process exit code, and does it reflect all critical conditions?
39. Does the runtime ever return exit `0` while recording a critical event?
40. Does a failed self-protection check halt only the current cycle, or also block the next cycle until correction?
41. Where is "refuse next cycle until corrected" persisted?
42. If the engine crashes halfway through a cycle, what durable state exists to resume or diagnose the failure?
43. Are there top-level `try/catch` boundaries around CLI and runner paths?
44. Does an unhandled sink failure crash the process, get recorded, or get swallowed?
45. Does a collector exception prevent all other probes from running, or is failure isolated per probe?

## D. Event ledger and audit correctness

46. What are all `EventKind` enum values, and how many have zero production emitting callsites?
47. For every event kind, where is it emitted, where is it consumed, and where is it tested?
48. Which event kinds are purely informational, and which must trigger alerts, non-zero exits, or refusal states?
49. Are `revert_applied` and `revert_failed` emitted anywhere? If not, should they be removed or should auto-revert be implemented?
50. Is there a canonical table mapping event kind → severity → alert behavior → exit behavior → retention behavior?
51. Are event writes atomic with the state changes they audit?
52. Is `mute_set` written in the same transaction as mute creation?
53. Is `mute_expire` written in the same transaction as mute expiration?
54. Are alert delivery events written in the same logical operation as sink attempts?
55. Can the ledger record duplicate events for the same attempt because of retry or crash behavior?
56. Are event payload schemas validated on write and on read?
57. Can a malformed historical event crash status, watchdog, or dedup logic?
58. Does the ledger support forward-compatible unknown event payloads?
59. Does the code distinguish "event could not be written" from "event written but alert failed"?
60. What happens if SQLite is locked, corrupt, missing, or read-only?
61. Are JSONL and SQLite stores consistent with each other, or can they diverge?
62. Which store is authoritative when JSONL and SQLite disagree?
63. Are HMAC/canonical JSON protections applied to all baseline-relevant state or only some paths?
64. Is baseline tampering recorded as a critical event and surfaced to the operator?
65. Does baseline integrity failure stop drift evaluation and also alert / exit non-zero?

## E. Alerting, sink chain, and delivery semantics

66. What exact code path converts drift or critical events into alert payloads?
67. Are alerts generated only for `drift`, or for all actionable event kinds?
68. Where is `runChannelChain` called from production runtime?
69. Which sinks are instantiated in runtime code, not just unit tests?
70. Are WhatSoup `/send`, local log, local notify, ntfy, Pushover, and webhook sinks all reachable from config?
71. Are meta-alert sinks actually used by the watchdog path?
72. Does alert fall-through stop after first success, or continue to all sinks?
73. Is the intended delivery model documented: first-success, all-channels, priority chain, or fanout?
74. Are alert delivery failures recorded per sink?
75. Is "all sinks failed" recorded as a separate event?
76. Are retry and backoff policies bounded, tested, and observable?
77. Does a slow sink block the whole cycle beyond the intended interval?
78. Are sink timeouts configurable?
79. Does the code prevent secret leakage in alert payloads, logs, delivery errors, and test snapshots?
80. Are copy-paste mute hints fully executable against the real CLI?
81. Do mute hints include required flags such as `--state-dir`, `--duration`, `--reason`, and the correct scope/domain flags?
82. Does shell quoting handle spaces, quotes, semicolons, dollar signs, backticks, newlines, and Unicode?
83. Are alert examples in the README generated from real formatter output or hand-written?
84. Does status output show delivery health clearly enough for an operator to see broken notification paths?
85. Is there a test that removes `runChannelChain` from `runCycle` and fails?

## F. Deduplication, muting, and storm-guard behavior

86. Where is dedup suppression called in the production path?
87. Where is storm-guard suppression called in the production path?
88. Are dedup and storm-guard applied before formatting and delivery?
89. Are suppressed events recorded as `drift_dedup` or equivalent audit records?
90. Are muted events recorded, suppressed silently, or counted separately?
91. Does severity escalation bypass dedup correctly?
92. Does a critical event bypass mute, or does mute apply to critical events too?
93. Is the mute domain/scope matching logic identical between CLI, formatter hint, and runtime suppression?
94. Are expired mutes cleaned up every cycle?
95. What happens if the system clock moves backward or forward across mute expiry windows?
96. Are dedup windows documented and configurable?
97. Does dedup state survive process restart?
98. Is storm-guard keyed by stable canonical identity or fragile formatted text?
99. Are dedup/storm decisions explained in status output?
100. Are there tests for same drift, changed severity, changed domain, changed scope, and changed payload?

## G. Self-protection and fail-closed behavior

101. What exact self-secret files or tokens are checked each cycle?
102. Does the self-secret check inspect permissions, ownership, existence, readability, and age?
103. What code emits `self_secret_widened`?
104. What code consumes `self_secret_widened`?
105. Does `self_secret_widened` trigger alert delivery?
106. Does `self_secret_widened` force a non-zero CLI exit?
107. Does `self_secret_widened` prevent subsequent cycles until corrected?
108. Where is the refusal state stored?
109. Can an operator intentionally acknowledge or reset refusal state?
110. Are token-age warnings actionable, informational, or blocking?
111. Are token-age thresholds configurable?
112. Are self-protection failures included in simulator scenarios?
113. Are self-protection failures included in README operator workflows?
114. Do self-protection logs redact paths, usernames, tokens, and secret material?
115. Does the engine ever continue normal drift evaluation after a fail-closed condition?

## H. Watchdog and meta-alert architecture

116. Is there a real watchdog process entrypoint, or only pure detection functions?
117. If the plan names `src/watchdog/index.ts`, does that file exist?
118. How does an operator run the watchdog?
119. Does the CLI expose a watchdog command?
120. Does the watchdog read durable ledger state or in-memory state?
121. Does the main runner write heartbeat events every cycle?
122. Does the watchdog test use real ledger queries or precomputed numeric inputs?
123. What happens if the engine dies before writing a heartbeat?
124. What happens if alerts fail but heartbeat continues?
125. Can the engine fake heartbeats to silence the watchdog?
126. Is same-host watchdog explicitly accepted for v1, and is off-host watchdog deferred?
127. Are meta-alert sinks instantiated and called from watchdog runtime?
128. Are watchdog failures themselves logged or alerted?
129. Does the watchdog have independent config from the engine?
130. Is watchdog status visible from `whatsoup-guard status`?

## I. Policy, profiles, actions, and domain coverage

131. What policy schema fields are parsed but never used?
132. Is `deployment_roles` evaluated in production runtime?
133. Do role violations produce drift events?
134. Are policy `actions` parsed?
135. If actions are parsed, where are they enforced?
136. If actions are not enforced, does the plan remove or explicitly defer them?
137. Are auto-revert actions implemented, or merely represented by enum names?
138. Does the policy support alert-routing configuration, and is it wired?
139. Does the policy support sink configuration, and is it wired?
140. Does profile inheritance work exactly as the spec states?
141. Is the intended profile chain actually implemented, or are profiles siblings extending a common base?
142. Are profile defaults tested through the real loader?
143. Are policy overrides deep-merged, shallow-merged, or replaced?
144. Are invalid policy combinations rejected with useful errors?
145. Do all declared posture domains have at least one production evaluator?
146. Which domains are simulator-only?
147. Is exposure drift detected from real collector observations or hardcoded fixtures?
148. Is credential drift detected only from engine self-checks, or from deployment posture observations too?
149. Is capability drift implemented for real policy roles?
150. Are network, auth, credential, capability, and deployment domains all end-to-end testable?

## J. Collectors, evaluators, and production realism

151. Which collectors are real, fixture-only, or deferred?
152. Does the runtime accidentally imply deferred platform collectors exist?
153. Are fixture collectors clearly isolated from production paths?
154. Can the CLI run a cycle without real collectors and still exit successfully in a misleading way?
155. Does the code distinguish "no collectors configured" from "no drift"?
156. Are evaluator inputs normalized before comparison?
157. Do evaluator outputs use stable IDs for dedup/storm-guard?
158. Are evaluator failures recorded separately from "no drift"?
159. Are collector timeouts and partial failures handled?
160. Are platform-specific assumptions absent from universal code?
161. Do tests cover multiple probes in one cycle?
162. Does one failed probe prevent alerting for another successful drift finding?
163. Is there a canonical evaluator registry?
164. Are evaluator modules discoverable by policy domain, or manually hardcoded?
165. Does adding a new evaluator require editing too many places, violating DRY?

## K. CLI, operator workflow, and documentation accuracy

166. Does every README command actually run against the current CLI?
167. Does every CLI option in docs exist in parser code?
168. Are there phantom flags such as `--json` in docs or plans?
169. Does `status` show mutes, dedup, storm guard, delivery status, self-protection state, and watchdog health?
170. Does `mute` write both state and audit events?
171. Does `simulate` exercise the same formatter and sink chain as real runtime?
172. Does `cycle` require `--policy` and `--state-dir`, and are those consistently documented?
173. Does the runtime invocation use `tsx`, native strip-types, compiled JS, or something else?
174. Is `tsx` a declared dependency where it is used?
175. Does the root launcher policy permit the guard runtime invocation pattern?
176. Is the runtime test aligned with repo launcher conventions?
177. Are CLI error messages human-readable and stable enough for tests?
178. Do CLI errors use consistent naming: snake_case, kebab-case, or camelCase?
179. Do all CLI commands return appropriate exit codes for success, user error, and critical system failure?
180. Are incident-time commands copy-paste safe and complete?

## L. Tests, coverage, and falsification

181. Which tests are pure unit tests, which are integration tests, and which are end-to-end CLI subprocess tests?
182. Is there a test that fails if event emission occurs but alert delivery does not?
183. Is there a test that fails if self-protection events are not consumed?
184. Is there a test that fails if baseline integrity failure exits `0`?
185. Is there a test that fails if watchdog runtime entrypoint is missing?
186. Is there a test that proves policy actions are honored or explicitly rejected?
187. Is there a test that proves profile inheritance chain semantics?
188. Is there a migration upgrade test from an old DB schema to the current schema?
189. Are migrations idempotent?
190. Are migrations transactional?
191. Are old ledgers readable after schema changes?
192. Are package tests run with `--pool=forks` as required?
193. Are flaky tests repeated enough to justify "not reproduced" claims?
194. Are tests independent of local machine paths, usernames, hostnames, and installed tools?
195. Do tests create temp state under safe temp directories and clean it up?
196. Do tests assert negative cases, not just happy paths?
197. Are test fixtures minimal and representative, or large enough to hide intent?
198. Is there a mutation-style check: removing each key integration call should break at least one test?
199. Are mocks hiding runtime missing imports or missing file creation?
200. Does CI run the same command set as local verification?

## M. Security and privacy checks

201. Can any alert, log, event payload, or test snapshot leak tokens, hostnames, usernames, group names, JIDs, IPs, or private runbook references?
202. Are redaction rules depth-limited, and is that limit documented?
203. Do logs redact nested payloads used by this guard package?
204. Are HMAC keys generated, stored, read, rotated, and permission-checked safely?
205. Is canonical JSON resistant to unstable key order, undefined values, dates, NaN, infinity, BigInt, functions, and cyclic objects?
206. Are shell commands built with argument arrays rather than interpolated strings?
207. Are subprocess calls using safe wrappers such as `execFile` patterns?
208. Are hook false positives worked around by changing code safely, not by disabling hooks?
209. Does the plan forbid adding allow-list exceptions unless justified by first-hand evidence?
210. Are local notification, webhook, ntfy, Pushover, and WhatSoup send errors sanitized before storage?
211. Can untrusted policy values become shell, SQL, HTTP header, URL, or file path injection vectors?
212. Are SQLite queries parameterized throughout?
213. Are file writes protected against path traversal from policy fields?
214. Are state directories created with restrictive permissions?
215. Are secret files opened in a way that avoids symlink surprises?

## N. Reliability, resilience, and failure modes

216. What happens when the state directory does not exist?
217. What happens when the state directory is not writable?
218. What happens when disk is full?
219. What happens when SQLite is locked?
220. What happens when JSONL append fails after SQLite succeeds, or vice versa?
221. What happens when a sink hangs forever?
222. What happens when system time changes dramatically?
223. What happens when policy file is missing, malformed, or partially valid?
224. What happens when profile extension references a missing profile?
225. What happens when baseline exists but is from an older schema version?
226. Does the engine fail closed or fail open for integrity failures?
227. Does the engine distinguish transient transport failures from policy violations?
228. Are retries bounded to avoid alert storms?
229. Can one noisy domain starve alerts from other domains?
230. Can one corrupted event prevent status or watchdog from running?

## O. DRY, maintainability, and project-pattern alignment

231. Are event kind names duplicated across schemas, tests, docs, and runtime code?
232. Is there a single source of truth for event kind → severity → actionability?
233. Is there a single source of truth for CLI flags used by formatter hints and parser definitions?
234. Is there a single source of truth for profile inheritance?
235. Is there a single source of truth for sink registry and config schema?
236. Is there a single source of truth for policy domains?
237. Are simulator scenarios reusing production code or reimplementing behavior?
238. Are tests duplicating command strings that should come from helper builders?
239. Are package scripts consistent with repository conventions?
240. Are new modules following TypeScript/ESM import conventions used elsewhere?
241. Are Zod schemas colocated with the data they validate?
242. Is Pino logging used consistently?
243. Is better-sqlite3 used consistently with repository patterns?
244. Are migrations declared as single-statement DDL strings if that is the repo convention?
245. Are public docs sanitized according to the project's leakage rules?

## P. Dead code, orphan modules, and misleading surface area

246. Which exported functions are only referenced by tests?
247. Which files under `src/` have no production import path?
248. Which CLI commands are documented but not implemented?
249. Which event kinds are declared but never emitted?
250. Which event kinds are emitted but never consumed?
251. Which sink classes are implemented but never constructed?
252. Which policy fields are parsed but ignored?
253. Which README workflows require commands that do not exist?
254. Which plan tasks refer to files that were never created?
255. Which tests assert behavior of modules that are not reachable from runtime?
256. Should dead code be removed, wired, or explicitly deferred?
257. Does leaving dead enum members create audit-query false positives?
258. Does leaving unused sinks create operator false confidence?
259. Does leaving unused profile fields create policy false confidence?
260. Does the plan require a dead-code cleanup task before release?

## Q. Simulator and acceptance scenario proof

261. What are the exact simulator scenarios promised by the plan?
262. Which scenarios pass through production formatter and sink chain?
263. Which scenarios use fake collectors?
264. Which scenarios use real EventStore persistence?
265. Which scenarios exercise mutes?
266. Which scenarios exercise dedup?
267. Which scenarios exercise storm guard?
268. Which scenarios exercise alert fall-through?
269. Which scenarios exercise watchdog silence?
270. Which scenarios exercise transport-broken?
271. Which scenarios exercise self-secret widening?
272. Which scenarios exercise baseline integrity failure?
273. Which scenarios exercise deployment role violation?
274. Which scenarios exercise policy actions?
275. Does simulator output include enough evidence for an operator to trust it?

## R. Plan revision requirements

276. Which findings require revising the current plan in place rather than creating a new follow-up plan?
277. Which findings are release blockers?
278. Which findings are task-level fix-ups?
279. Which findings are documentation-only?
280. Which findings are explicitly deferred to a future version?
281. Does the plan have a blocker table with owner, severity, evidence, and exit criteria?
282. Does every blocker have a test that will fail until fixed?
283. Does every accepted deferral include risk, rationale, and a future tracking artifact?
284. Does the plan remove stale claims after new evidence contradicts them?
285. Does the plan distinguish "closed first-pass IG" from "closed spec behavior"?
286. Does the plan now include "consumption checks," not only "emission checks"?
287. Does the plan add a product-path matrix from input → policy → collector → evaluator → event → suppression → alert → sink → ledger → status?
288. Does the plan require line-numbered codebase references for every claim?
289. Does the plan require a final adversarial pass after fix-ups?
290. Does the plan require remote CI before any merge-ready language?

## S. Sub-agent orchestration and context-pollution controls

291. Which investigations should be delegated to separate sub-agents to avoid context pollution?
292. Does each sub-agent have a narrow question, bounded file set, and required output schema?
293. Are sub-agents forbidden from relying on previous reviewer summaries without verifying code?
294. Are sub-agents required to write durable artifacts rather than only chat summaries?
295. Is there a single synthesis agent that compares findings across sub-agents?
296. Are contradictory findings escalated to an arbiter rather than averaged?
297. Does the operator independently verify the most important claims after sub-agents return?
298. Does the workflow prevent reading full sub-agent transcripts unless needed?
299. Are sub-agent outputs stored under a clear evidence root with names tied to their scope?
300. Does the plan preserve the Gas Town rule: agents are disposable, artifacts are durable?

## T. Final merge-readiness questions

301. What exact conditions must be true before the branch can be called "merge-ready"?
302. Is root test status green, or are failures explicitly classified and accepted?
303. Is remote CI green on the reviewed SHA?
304. Is the branch pushed with upstream configured?
305. Are all high-severity findings closed by code and tests?
306. Are all medium-severity findings either closed or explicitly accepted with rationale?
307. Are all dead/misleading public interfaces removed, wired, or deferred?
308. Are docs, README, CLI help, and actual parser behavior aligned?
309. Has a final code review inspected the full diff from merge-base to HEAD?
310. Has a final gap analysis compared spec, plan, and code after the latest fix-up commits?
311. Has an adversarial review specifically probed "event written but not consumed"?
312. Has an architectural fitness review specifically probed DRY and reusable project patterns?
313. Has a usability review executed the copy-paste operator workflows?
314. Has a security review executed self-protection and baseline tamper scenarios?
315. Has a resilience review executed failure-injection scenarios?
316. Is the release note honest about what v1 does and does not do?
317. Are follow-up plans created for platform collectors, off-host watchdog, auto-revert, or other deferred capabilities?
318. Does the final plan avoid any claim that cannot be proven from code, tests, or CI?
319. Is there a rollback plan if the guard breaks existing root tests or launcher conventions?
320. Can a fresh agent, with only the durable artifacts and no chat history, reproduce the release-readiness verdict?

---

## Use as a checklist, not a questionnaire

Any "PASS" without file paths, line numbers, function names, and command evidence is rejected. Words like "appears", "probably", "seems", "should" without codebase evidence are rejected.

## Suggested execution structure

When this bank is run against the long-branch implementation plan:

1. **Wave 0 — baseline capture**
   - Identify the exact branch / SHA / merge-base under review
   - Confirm no untracked work in scope
   - Record CI state on that SHA (or document its absence)

2. **Wave 1 — sectional sub-agents (A through T, 20 agents)**
   - Each agent receives one section's questions + bounded file set
   - Each writes durable findings under `.git/preservation-audit/<DATE>/plan-review-evidence/section-<X>/findings.md` (or `docs/sdlc/<plan-key>/review-evidence/section-<X>.md` if that branch chooses to track)
   - No agent may use chat history; each receives only the question text + repo paths + current SHA

3. **Wave 2 — cross-section synthesis**
   - One synthesis agent reads every Wave 1 findings file
   - Produces consolidated blocker table, plan-revision diff, deferred-item registry
   - Escalates contradictions to arbiter rather than averaging

4. **Wave 3 — operator independent verification**
   - User picks 5-10 highest-stakes claims (typically from sections C, D, E, G, H — runtime flow, ledger, alerting, fail-closed, watchdog)
   - Verifies each first-hand against the code

5. **Plan revision pass**
   - Plan is rewritten in place against findings
   - Stale "ready to merge" / "release green" wording removed
   - Blocker table populated with owner, severity, evidence, exit criteria
   - Deferred items moved to explicit deferred-list with rationale + future tracking artifact

## Provenance notes

- Bank source: user message, 2026-05-10
- Captured-by: preservation-audit Conductor session 2026-05-09/10
- Subject under review (when executed): long-branch implementation plan + `tools/whatsoup_guard/` package on `origin/main`
- Status at capture: **not executed**. This file is reference only.
