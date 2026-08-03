# BOT ERRORS Durable Writer Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the shared, descriptor-confined writer slice for #2485 with
explicit outcomes consumed by all nine principal BOT ERRORS writers, while
leaving #2485 and #2464 open until Draft 3 proves the embedded cross-parent
residual.

**Architecture:** Introduce a manifest-tracked Python helper that publishes create-once events with descriptor-relative hard-link no-clobber semantics and mutable state with an expected-predecessor fence under canonical `flock` locking. Outcomes independently record durability, confinement, cleanup debt, authority, stage, and bounded error class. Migrate callers in small groups, prove every ambiguous boundary through injected faults and real crash/restart tests, and replace source-string checks with a behavior-backed structural inventory.

**Tech Stack:** Python 3.12, pytest, TypeScript/Vitest guards, Node.js 24.15.0, Darwin/Linux `fcntl.flock`, descriptor-relative POSIX filesystem APIs.

## Global Constraints

- Audit base revision: `ec1cd2ae5ed766ea78850936b6b7a7360f02bba1`.
- PR #2603 final reviewed head `fe3bad7673e142e5db9ece6c30ec78f8ec7ba151`
  is tree-identical to squash commit `51e78876e406e332c97e36a0a3b6d13df13cbcf5`.
- PR #2604 final reviewed head `8bfeeb9523a1ad42ca88e67ce23569b25a2bec09`
  is tree-identical to squash commit `455c8af4c48c10fecee4170218f5bde9418d5c97`.
- Combined dependency base `a18b17553c8cfcbaa07f1a57e7df1844171be955`
  contains both squash commits.
- Draft 1 closes neither #2485 nor #2464. Both remain `IN PROGRESS`; Draft 3 is
  the earliest #2485 closure gate.
- #2427 and #2482 remain separate later drafts in this lane. #2463 has a
  separate recorded owner and is coordination-only; #2429 remains open.
- TypeScript turn-recovery issues #2148, #2150, #2151, and #2169 are out of scope.
- Event publication is create-once/no-clobber; state publication requires an expected predecessor.
- The selected Darwin/Linux fence is `fcntl.flock(LOCK_EX)` on a verified descriptor-relative lock entry.
- Missing `fcntl`, no-follow, directory-sync, or descriptor-relative link capability fails before mutation.
- `advance_allowed` requires committed/reconciled durability, proven confinement, intended authority, no conflict, and cleanup in `complete`, `not_required`, or `debt_private_temp`.
- `debt_recovery_record`, conflict, supersession, unknown authority, or unproven durability blocks lifecycle advancement.
- No caller may emit queued, saved, healthy, recovered, acknowledged, suppressed, cleared, or terminal success from an unproven result.
- Public diagnostics contain only component class, outcome axes, stage,
  bounded error class, and generation/count. Draft 1 emits no correlation
  token because no reviewed key-provisioning, rotation, isolation, or
  retention contract exists.
- Raw paths, filenames, payloads, operation IDs, content digests, identities, destinations, processes, hosts, accounts, messages, credentials, and topology never enter public receipts, tests, issues, or PR text.
- No production deployment, restart, live state read, fleet mutation, or issue label transition occurs before the draft is exact-head validated.
- Masked, skipped, stale, environment-blocked, or unavailable checks are inconclusive.

---

## File Map

| File | Responsibility |
|---|---|
| `deploy/scripts/lib/durable_json.py` | Shared types, descriptor traversal, locking, event/state publication, reconciliation, cleanup, and changed-parent barriers. |
| `deploy/scripts/lib/durable_json_remote.py` | Canonical remote-compatible subset embedded into acknowledgement scripts. |
| `deploy/scripts/generate-bot-errors-remote-durability.py` | Deterministic serializer for embedded remote durability source. |
| `deploy/scripts/tests/test_durable_json.py` | Complete helper fault matrix, concurrency, capability, descriptor-race, and crash/restart tests. |
| `deploy/bot-errors-durable-writer-inventory.json` | Exact nine-writer call-site classification and allowed diagnostic-only exceptions. |
| `deploy/scripts/check-bot-errors-durable-writers.py` | AST/inventory guard that rejects inline clones, unclassified writers, ignored results, and weaker-API use. |
| `tests/scripts/bot-errors-python-atomic-write-guard.test.ts` | Guard mutation and end-to-end wrapper tests; no source-string sufficiency claims. |
| `deploy/scripts/bot-errors-emit.py` | Create-once event caller. |
| `deploy/scripts/bot-errors-runner.py` | Create-once event caller. |
| `deploy/scripts/bot-errors-collector.py` | State and event callers with explicit results. |
| `deploy/scripts/bot-errors-dispatcher.py` | State and event callers with explicit results. |
| `deploy/scripts/bot-errors-health-check.py` | Deadman/verification state and event callers. |
| `deploy/scripts/bot-errors-heartbeat-watchdog.py` | Watchdog state and event callers. |
| `deploy/scripts/bot-errors-q-loop.py` | Q-loop state caller. |
| `deploy/scripts/bot-errors-selfcheck.py` | Memory/status/heartbeat/event callers. |
| `deploy/scripts/bot-errors-sentinel.py` | Sentinel state/heartbeat/digest/event/ack callers. |
| `deploy/scripts/bot-errors-maintenance.py` | Shared maintenance-state publisher. |
| `deploy/scripts/bot-errors-gui-session-monitor.py` | Shared GUI-session state publisher. |
| `deploy/scripts/bot-errors-tree-provenance.py` | Shared provenance outbox publisher. |
| `deploy/scripts/bot_errors_cutover.py` | Watchdog-writer consumer that must consume the typed result. |
| `deploy/bot-errors-runtime-manifest.json` | Exact shared-helper generation and source hashes. |
| `deploy/scripts/whatsoup-bot-errors-deploy.sh` | Coherent helper installation and rollback bundle. |
| `scripts/check-bot-errors-runtime-manifest.ts` | Runtime required-file inventory. |
| `tests/scripts/check-bot-errors-runtime-manifest.test.ts` | Missing/mixed helper generation and isolated bundle tests. |
| Component-focused Python and TypeScript tests | Caller-specific RED/GREEN behavioral evidence. |

### Task 1: Resolve the #2603/#2604 combined base and create the implementation worktree

**Files:**
- Read: `docs/superpowers/specs/2026-07-28-bot-errors-durability-stack-design.md`
- Read: `docs/superpowers/plans/2026-07-28-bot-errors-durable-writer-outcomes-2485.md`
- No production file changes.

**Interfaces:**
- Produces: isolated implementation branch whose base contains the reviewed
  semantics of both #2603 and #2604.

- [x] **Step 1: Re-read both live collision records**

```bash
gh pr view 2603 --repo LucasQuiles/WhatSoup --json state,isDraft,headRefName,headRefOid,baseRefName,files,mergeCommit,statusCheckRollup
gh pr view 2604 --repo LucasQuiles/WhatSoup --json state,isDraft,headRefName,headRefOid,baseRefName,files,mergeCommit,statusCheckRollup
```

Observed: both PRs are merged, all hosted checks are terminal-green, and their
final reviewed heads are tree-identical to the squash commits recorded above.
Any later replacement or revert is a stop condition for renewed collision
review.

- [x] **Step 2: Fetch both exact dependencies through SSH**

For open PRs:

```bash
git fetch git@github.com:LucasQuiles/WhatSoup.git refs/pull/2603/head:refs/heads/dependency/pr-2603-controller-log
git fetch git@github.com:LucasQuiles/WhatSoup.git refs/pull/2604/head:refs/heads/dependency/pr-2604-runtime-health
test "$(git rev-parse refs/heads/dependency/pr-2603-controller-log)" = "615dd194f01f3440b27dd556a0e0a21e5d43e9bf"
test "$(git rev-parse refs/heads/dependency/pr-2604-runtime-health)" = "8b5dec468f2e1ce7bb134b05454443535475e0d3"
```

For merged PRs, fetch `main` over SSH and resolve the exact merge/squash
commit containing each reviewed change.

- [x] **Step 3: Establish one reviewed combined dependency head**

If both PRs are merged, use the exact main head containing both. Otherwise,
create a private integration branch from the dependency selected as first
parent and merge the other exact head without publishing or changing either
owner PR. The private merge is for implementation and test evidence only; it
is not a publishable PR base. If the merge conflicts, inspect `git merge-tree`
and resolve each hunk by preserving both controller-log and runtime-health
contracts, then require independent review of the five overlapping files. If
that semantic resolution is not unambiguous, abort the integration and wait
for the dependency owners to establish a public stack. Run:

```bash
COMMON_BASE="$(git merge-base dependency/pr-2603-controller-log dependency/pr-2604-runtime-health)"
git range-diff "$COMMON_BASE"...dependency/pr-2603-controller-log "$COMMON_BASE"...dependency/pr-2604-runtime-health
git cherry -v dependency/pr-2603-controller-log dependency/pr-2604-runtime-health
git cherry -v dependency/pr-2604-runtime-health dependency/pr-2603-controller-log
```

Then run controller-log, runtime-health, manifest, deployer, and affected
health-check tests on the combined head. Before opening Draft 1, also run the
new durability suite and full BOT ERRORS suite on the completed combined
implementation head. Any unresolved semantic conflict or failing test blocks
Draft 1; neither sibling may be silently preferred.

After the reviewed merge and focused tests pass:

```bash
export COMBINED_DEPENDENCY_HEAD="$(git rev-parse HEAD)"
```

- [x] **Step 4: Create a new isolated implementation worktree**

Use the `using-git-worktrees` skill. Name the branch
`fix/bot-errors-durable-writer-outcomes-2485-impl-20260728` and base it on the
exact combined dependency commit selected in Step 3.

- [x] **Step 5: Bring the approved design and plan onto the implementation branch**

First verify:

```bash
git cat-file -e 7de1b4438defb6ee8b6ca89fbe905b7cfc655428^{commit}
if git merge-base --is-ancestor 7de1b4438defb6ee8b6ca89fbe905b7cfc655428 "$COMBINED_DEPENDENCY_HEAD"; then
  echo "design commit already present in combined dependency"
  exit 1
fi
```

Then cherry-pick the design commit
`7de1b4438defb6ee8b6ca89fbe905b7cfc655428` and the commit containing this
plan. Resolve only documentation index/audit conflicts. Do not absorb unrelated
source changes.

- [x] **Step 6: Prove the combined base**

```bash
git range-diff ec1cd2ae5ed766ea78850936b6b7a7360f02bba1..7de1b4438defb6ee8b6ca89fbe905b7cfc655428 "$COMBINED_DEPENDENCY_HEAD"..HEAD
git cherry -v "$COMBINED_DEPENDENCY_HEAD" HEAD
git diff --name-only "$COMBINED_DEPENDENCY_HEAD"...HEAD
```

Expected: only the approved design/plan documentation differs before implementation.

Observed on the combined base:

- `git range-diff` accounts for both source documentation commits against
  their current-main regenerated audit and work-index forms;
- `git cherry -v` reports only the two carried documentation commits plus the
  live ownership/base reconciliation commit;
- the branch diff contains only the design, plan, publication audit, and two
  generated work-index files;
- 1,400 Python tests and 286 focused TypeScript tests passed; and
- the runtime-manifest guard and deploy verifier passed.

### Task 2: Lock the caller inventory and write the RED shared fault matrix

**Files:**
- Create: `deploy/bot-errors-durable-writer-inventory.json`
- Create: `deploy/scripts/tests/test_durable_json.py`
- Create: `deploy/scripts/check-bot-errors-durable-writers.py`
- Modify: `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`

**Interfaces:**
- Produces:
  - inventory schema version 1;
  - exact caller records `{site_id, script, function, logical_publication,
    kind, operation_identity_source, result_policy, result_consumer,
    fault_test_ids}`;
  - guard exit 0 pass, 1 violation, 2 inconclusive.

```ts
interface DurableWriterInventoryRow {
  site_id: string;
  script: string;
  function: string;
  logical_publication: string;
  kind:
    | "event_create_once"
    | "state_replace_expected"
    | "diagnostic_state"
    | "lifecycle_move_deferred_draft_3";
  operation_identity_source: "durable_json.operation_id.v1" | "deferred_draft_3";
  result_policy:
    | "require_advance"
    | "explicit_advance_check"
    | "propagate_result"
    | "aggregate_all"
    | "deferred_draft_3";
  result_consumer: string;
  fault_test_ids: string[];
}
```

`site_id` is a stable, unique inventory identifier. The guard resolves each
row to a helper or deferred-move call inside the named function; file-level
presence is insufficient. `result_consumer` names the enclosing or downstream
function that enforces the closed `result_policy`. Assignment alone is not
consumption: the guard must prove that the bound value reaches
`require_advance`, an `advance_allowed` branch, a typed propagation return, or
an `aggregate_all` gate. `logical_publication` is a bounded component-scoped
identifier, not a path or payload-derived value.

- [ ] **Step 1: Encode all principal and same-root cooperating writers**

The top-level coverage skeleton must contain exactly these script/adapter sets,
plus a `callers: DurableWriterInventoryRow[]` array populated by the audited
call sites:

```json
{
  "schema_version": 1,
  "helper_generation": 1,
  "principal_scripts": [
    "deploy/scripts/bot-errors-collector.py",
    "deploy/scripts/bot-errors-dispatcher.py",
    "deploy/scripts/bot-errors-emit.py",
    "deploy/scripts/bot-errors-health-check.py",
    "deploy/scripts/bot-errors-heartbeat-watchdog.py",
    "deploy/scripts/bot-errors-q-loop.py",
    "deploy/scripts/bot-errors-runner.py",
    "deploy/scripts/bot-errors-selfcheck.py",
    "deploy/scripts/bot-errors-sentinel.py"
  ],
  "cooperating_scripts": [
    "deploy/scripts/bot-errors-gui-session-monitor.py",
    "deploy/scripts/bot-errors-maintenance.py",
    "deploy/scripts/bot-errors-tree-provenance.py",
    "deploy/scripts/bot_errors_cutover.py"
  ],
  "embedded_publishers": [
    "collector.REMOTE_CLAIM_SCRIPT.<module>",
    "collector.REMOTE_ACK_SCRIPT.<module>",
    "collector.REMOTE_WRITEFAIL_CLAIM_SCRIPT.<module>",
    "collector.REMOTE_WRITEFAIL_ACK_SCRIPT.write_ack_journal",
    "collector.REMOTE_WRITEFAIL_ACK_SCRIPT.copy_claim_atomic",
    "collector.REMOTE_WRITEFAIL_ACK_SCRIPT.move_claim_terminal",
    "collector.REMOTE_WRITEFAIL_ACK_SCRIPT.<module>"
  ],
  "diagnostic_only_weaker_callers": [
    "collector.persist_controller_log_health",
    "dispatcher.persist_controller_log_health",
    "health-check.persist_controller_log_health",
    "heartbeat-watchdog.persist_controller_log_health",
    "q-loop.persist_controller_log_health"
  ],
  "callers": []
}
```

Add one caller row for every current `atomic_write_json(...)` call, inline
write-failure publisher, evidence-sidecar publisher, and cooperating or
embedded same-root publisher. Classify each as `event_create_once`,
`state_replace_expected`, `diagnostic_state`, or
`lifecycle_move_deferred_draft_3`. Event identity comes from the existing
durable event/record ID as part of the canonical payload and lexical target;
state identity uses expected predecessor plus intended canonical content.
Every non-deferred row names `durable_json.operation_id.v1` as its exact
identity source, and the guard proves the call passes that derived identity to
the matching helper. Diagnostic controller-log state preserves
#2603's bounded non-domain-fatal policy but must inspect a typed result. No
principal or cooperating caller may use a weaker publication API.
The empty array above is a schema skeleton only; the checked-in inventory is
invalid until the audit populates a nonempty exact row set and the guard proves
coverage in both directions.
The cutover repair consumer must either consume the watchdog writer's typed
result or call a fail-closed compatibility adapter; importing the old writer
and discarding the result is forbidden.

- [ ] **Step 2: Replace source-string tests with RED behavior/AST tests**

Mutate synthetic fixture scripts to prove the guard rejects:

- inline `atomic_write_json` or `fsync_parent` clones;
- a helper call whose result is ignored;
- a helper result assigned but never referenced;
- a helper result assigned to `_`;
- a helper result used only by `str()`, `repr()`, logging, or serialization
  without an advance decision;
- an inventory row naming a function that does not contain the claimed call;
- a principal call absent from inventory;
- a caller marked best-effort;
- direct same-parent JSON `os.replace` outside the shared helper;
- equivalent inline write-and-rename publication under renamed helper
  functions, including `json.dump` or `Path.write_text` followed by rename;
- a missing principal script;
- a mixed helper generation; and
- malformed or duplicate inventory rows.

```ts
it("rejects a durable result that is discarded", () => {
  const fixture = pythonFixture(
    "publish_state_json(target, payload, component='fixture', operation_id=op_id, expected=expected, generation=1)",
  );
  expect(runGuard(fixture)).toMatchObject({ status: 1, code: "result-unconsumed" });
});
```

- [ ] **Step 3: Write the complete helper RED fault matrix**

Define tests before the module exists for:

- serialization failure;
- exclusive temporary-create collision;
- short write and `ENOSPC`;
- flush and file `fsync`;
- `fchmod`, owner/type/mode validation, and ambient umask;
- `EACCES`, `EMFILE`, and `ENFILE` during descriptor traversal/lock acquisition;
- hard-link no-clobber collision;
- state replacement and unexpected `EXDEV`;
- destination-parent and source-parent sync;
- unsupported directory sync;
- interruption after publication;
- private-temp cleanup debt;
- recovery-record debt blocking advancement;
- intended/predecessor/superseded/conflict/malformed/absent reconciliation;
- unknown-authority reconciliation;
- root/intermediate/leaf symlink and non-directory substitution;
- deterministic parent/target substitution at explicit post-validation test
  hooks; do not use probabilistic race loops as proof;
- hard-link policy;
- private-temporary link-count validation before publication;
- concurrent event writers;
- concurrent state writers;
- concurrent event/state writers contending on one protected parent;
- canonical two-parent lock order and crash release;
- deterministic interruption injection at every publication hook, plus real
  subprocess kill/restart at the event-publication-before-parent-sync and
  state-authority critical phases;
- committed success and idempotent same-operation reconciliation positive
  controls;
- same-parent barrier sync exactly once and cross-parent destination/source
  sync exactly once each; and
- serialization and ambiguity vectors exercised once per inventory
  classification in addition to the complete helper matrix.

- [ ] **Step 4: Run the first RED tests**

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_durable_json.py
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-python-atomic-write-guard.test.ts
```

Expected: assertion failures for the first guard and helper API behaviors
because the contracts are not implemented. A module-import or test-collection
error is not acceptable RED evidence. Introduce the smallest importable helper
or guard skeleton only after its existence/API test is observed RED, then add
the remaining matrix one behavior at a time in Task 3, observing each expected
failure before its implementation.

- [ ] **Step 5: Commit non-vacuous RED evidence**

```bash
git add deploy/bot-errors-durable-writer-inventory.json deploy/scripts/tests/test_durable_json.py deploy/scripts/check-bot-errors-durable-writers.py tests/scripts/bot-errors-python-atomic-write-guard.test.ts
git commit -m "test(durability): define durable writer fault matrix"
```

The commit may contain the smallest importable skeleton required to make the
recorded failures behavioral. It must not claim the complete matrix is RED
when every case fails only because one module or symbol is absent.

### Task 3: Implement the descriptor-confined publication primitive

**Files:**
- Create: `deploy/scripts/lib/durable_json.py`
- Modify: `deploy/scripts/tests/test_durable_json.py`

**Interfaces:**
- Produces:
  - `durable_json_target(*, trusted_root, relative_path) -> DurableJsonTarget`
  - `observe_json(target: DurableJsonTarget) -> JsonObservation`
  - `operation_id(target, payload, *, component, predecessor) -> str`
  - `publish_event_json(target, payload, *, component, operation_id) -> PublicationResult`
  - `publish_state_json(target, payload, *, component, operation_id, expected, generation) -> PublicationResult`
  - `reconcile_json_publication(intent, previous) -> PublicationResult`
  - `sync_changed_parents(...) -> ParentSyncResult`
  - `require_advance(result: PublicationResult) -> None`

Execute the fault matrix as explicit RED/GREEN cycles. Add one behavioral
case, observe its expected assertion failure against an importable helper,
implement the minimum contract for that case, and rerun it before adding the
next case. Preserve the RED receipt for each fault ID. A bulk matrix that
fails only at the first missing symbol is not evidence for the remaining
cases.

- [ ] **Step 1: Define closed outcome and stage types**

```py
class DurabilityProof(str, Enum):
    NOT_MUTATED = "not_mutated"
    COMMITTED = "committed"
    UNPROVEN = "unproven"
    RECONCILED_COMMITTED = "reconciled_committed"

class ConfinementProof(str, Enum):
    PROVEN = "proven"
    UNPROVEN = "unproven"
    VIOLATED = "violated"

class CleanupState(str, Enum):
    NOT_REQUIRED = "not_required"
    COMPLETE = "complete"
    DEBT_PRIVATE_TEMP = "debt_private_temp"
    DEBT_RECOVERY_RECORD = "debt_recovery_record"

class AuthorityState(str, Enum):
    EXPECTED_PREDECESSOR = "expected_predecessor"
    INTENDED_AUTHORITATIVE = "intended_authoritative"
    SUPERSEDED = "superseded"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"

class WriteStage(str, Enum):
    SERIALIZATION = "serialization"
    CAPABILITY_CHECK = "capability_check"
    LOCK_ACQUISITION = "lock_acquisition"
    TEMPORARY_CREATION = "temporary_creation"
    WRITE = "write"
    FILE_FLUSH = "file_flush"
    FILE_SYNC = "file_sync"
    PERMISSION_FINALIZATION = "permission_finalization"
    PUBLICATION = "publication"
    PARENT_OPEN = "parent_open"
    PARENT_SYNC = "parent_sync"
    CLEANUP = "cleanup"
    RECONCILIATION = "reconciliation"

class ErrorClass(str, Enum):
    SERIALIZATION = "serialization"
    SIZE = "size"
    PERMISSION = "permission"
    DESCRIPTOR_EXHAUSTION = "descriptor_exhaustion"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    IO = "io"
    INTERRUPTION = "interruption"
    CONFLICT = "conflict"
    IDENTITY_TYPE = "identity_type"
    CLEANUP = "cleanup"
    UNKNOWN = "unknown"

@dataclass(frozen=True)
class PublicationResult:
    component: str
    durability: DurabilityProof
    confinement: ConfinementProof
    cleanup: CleanupState
    authority: AuthorityState
    stage: WriteStage
    error_class: ErrorClass | None
    generation: int | None
    private_operation_id: str
    private_content_sha256: str | None

    @property
    def advance_allowed(self) -> bool:
        return (
            self.durability in {
                DurabilityProof.COMMITTED,
                DurabilityProof.RECONCILED_COMMITTED,
            }
            and self.confinement is ConfinementProof.PROVEN
            and self.authority is AuthorityState.INTENDED_AUTHORITATIVE
            and self.cleanup in {
                CleanupState.NOT_REQUIRED,
                CleanupState.COMPLETE,
                CleanupState.DEBT_PRIVATE_TEMP,
            }
        )
```

`stage` and `error_class` are closed enums, not arbitrary exception text.
Private raw digests and operation IDs never appear in `public_projection()`.
That method returns only the closed component/outcome/stage/error/generation
values and no correlation token. `require_advance()` raises a bounded
`DurableWriteError` containing only the public projection.

Add a separate `PrePublicationFailure` constructor that is valid only when
durability is `NOT_MUTATED`, confinement is `PROVEN`, cleanup is complete or
confined-private-temp debt, and the expected predecessor is positively proven
authoritative. Permission, ownership, type, or path-confinement failures can
never be upgraded by digest comparison or directory-sync reconciliation.
Write RED tests for every rejected composite.

- [ ] **Step 2: Implement trusted-root and descriptor traversal**

Start from `/`, open each absolute component with `O_DIRECTORY | O_NOFOLLOW`, verify each descriptor with `fstat`, and verify configured trusted-root owner/mode. Traverse targets only with `dir_fd`. Never reopen a validated parent by pathname.

```py
def _walk_trusted_root(root: Path) -> Iterator[int]:
    if not root.is_absolute() or any(part in {".", "..", ""} for part in root.parts[1:]):
        raise DurableWriteError(ErrorClass.IDENTITY_TYPE)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in root.parts[1:]:
            next_fd = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=fd,
            )
            _assert_directory(next_fd)
            os.close(fd)
            fd = next_fd
        _assert_private_directory(fd)
        yield fd
    finally:
        os.close(fd)
```

Do not use `Path.resolve()` for trust decisions. Retain the original absolute
components, reject lexical `.`/`..`, and validate every opened descriptor
before continuing.

- [ ] **Step 3: Implement canonical locking**

Create/open one reserved lock entry descriptor-relatively, verify regular file/owner/mode, sync its first creation, and acquire `fcntl.flock(fd, LOCK_EX)`. Two-parent operations sort unique locks by `(st_dev, st_ino)` and hold them through the final barrier/recovery-record update. Missing `fcntl` returns pre-mutation inconclusive.

- [ ] **Step 4: Implement deterministic identity and predecessor fencing**

```py
@dataclass(frozen=True)
class JsonVersion:
    exists: bool
    raw_sha256: str | None
    generation: int | None
    operation_id: str | None

@dataclass(frozen=True)
class JsonObservation:
    payload: Mapping[str, Any] | None
    version: JsonVersion

@dataclass(frozen=True)
class DurableJsonTarget:
    trusted_root: Path
    relative_path: PurePath
    logical_target: str

def operation_id(
    target: DurableJsonTarget,
    payload: Mapping[str, Any],
    *,
    component: str,
    predecessor: JsonVersion,
) -> str:
    intended_sha256 = canonical_payload_sha256(payload)
    material = "\0".join([
        "whatsoup.durable-json.v1",
        component,
        target.logical_target,
        predecessor.raw_sha256 or "absent",
        intended_sha256,
    ]).encode("utf-8")
    return hashlib.sha256(material).hexdigest()
```

`DurableJsonTarget` is constructed only by the helper's validated target
factory. The factory preserves the original absolute trusted root, rejects
lexical `.`/`..`, and sets `logical_target` to the normalized POSIX spelling of
`relative_path`; callers cannot supply an unrelated logical name. Callers
derive the ID with this exported function from the exact payload and explicit
predecessor (`JsonVersion(exists=False, ...)` for create-once events), then pass
it to publication. Each publisher canonicalizes the payload again and
re-derives the ID before any mutation; mismatch is a typed prepublication
failure. The supplied ID is therefore a validation input, never authority to
override the target, predecessor, or bytes.

For state publication, compare the locked current digest, generation, and
operation identity to the complete explicit expected version before mutation.
The caller may compute a candidate payload after `observe_json()`, but the
helper re-observes and performs compare-and-swap under the same lock as
publication. Intended content already present reconciles the same operation; a
different current version is superseded/conflict and is never overwritten.

- [ ] **Step 5: Implement event and state publication**

Event:

1. exclusively create/finalize/fsync a sibling temporary;
2. descriptor-relative `os.link()` temporary to absent target;
3. unlink temporary;
4. sync parent;
5. classify cleanup separately.

State:

1. prove expected predecessor under lock;
2. create/finalize/fsync sibling temporary;
3. descriptor-relative `os.replace()` under the held fence;
4. sync parent;
5. reconcile any post-replace ambiguity.

Permission/ownership finalization occurs before publication. `EXDEV` is a pre-mutation failure in this helper.

- [ ] **Step 6: Implement event and state reconciliation**

`reconcile_json_publication()` starts from the trusted-root descriptor again,
re-walks without following links, verifies the expected parent device/inode,
reads through the bounded safe reader, verifies operation ID, generation,
expected predecessor, and private raw digest, and retries the required parent
barrier when supported. It returns intended, superseded, conflict, or unknown
authority and never blindly republishes.

- [ ] **Step 7: Implement destination-before-source parent barriers**

`sync_changed_parents(destination, source)` syncs one parent once when device/inode match; otherwise destination first and source second. Return which barrier failed without collapsing it to ordinary success.

- [ ] **Step 8: Run the helper matrix GREEN**

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_durable_json.py
```

Expected: all helper tests pass on the current platform; unsupported-platform tests assert explicit inconclusive results.

- [ ] **Step 9: Commit the helper**

```bash
git add deploy/scripts/lib/durable_json.py deploy/scripts/tests/test_durable_json.py
git commit -m "feat(durability): add fenced JSON publication"
```

### Task 4: Migrate emitter, runner, and same-root utility publishers

**Files:**
- Modify: `deploy/scripts/bot-errors-emit.py`
- Modify: `deploy/scripts/bot-errors-runner.py`
- Modify: `deploy/scripts/bot-errors-maintenance.py`
- Modify: `deploy/scripts/bot-errors-gui-session-monitor.py`
- Modify: `deploy/scripts/bot-errors-tree-provenance.py`
- Modify: `deploy/scripts/tests/test_bot_errors_emit_preflight.py`
- Modify: `tests/scripts/bot-errors-runner.test.ts`
- Add/modify focused event-write tests as required by inventory.

**Interfaces:**
- Consumes: `observe_json`, `publish_event_json`, and `publish_state_json`.
- Produces: event queued only when `result.advance_allowed` is true.

- [ ] **Step 1: Add RED caller tests**

For all five scripts inject parent-open failure, parent-sync failure, target
collision, post-link interruption, and cleanup debt. Include emitter/runner
inline replayable write-failure records and the emitter evidence sidecar.
Assert:

- committed or reconciled-committed returns the target;
- unproven/conflict never prints queued success;
- the existing write-failure breadcrumb is metadata-only;
- retry of the same event converges without duplicating it; and
- a different event at the same target is not overwritten.

At least one emitter and one runner test must inject interruption after the
hard-link publication, call `reconcile_json_publication()` with the same
stable intent, and prove the caller advances only from
`RECONCILED_COMMITTED`.

- [ ] **Step 2: Run RED component tests**

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_bot_errors_emit_preflight.py
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-runner.test.ts
```

Expected: new fault assertions fail against inline writers.

- [ ] **Step 3: Replace inline publication**

```py
target = durable_json_target(
    trusted_root=state_dir(),
    relative_path=final.relative_to(state_dir()),
)
absent = JsonVersion(
    exists=False,
    raw_sha256=None,
    generation=None,
    operation_id=None,
)
op_id = operation_id(
    target,
    event,
    component="emitter",
    predecessor=absent,
)
result = publish_event_json(
    target,
    event,
    component="emitter",
    operation_id=op_id,
)
if not result.advance_allowed:
    record_write_failure(result.public_projection())
    raise DurableWriteNotCommitted(result.public_projection())
```

Runner uses component `"runner"` and its existing event ID. Maintenance and
GUI state carry explicit observed revisions; tree-provenance uses create-once
event identity. Remove inline writers only after every inventoried call is
migrated.

- [ ] **Step 4: Run GREEN tests and guard**

Run the Step 2 tests plus:

```bash
python3.12 deploy/scripts/check-bot-errors-durable-writers.py --inventory deploy/bot-errors-durable-writer-inventory.json
```

Expected: tests pass; the guard may still report the seven intentionally
unmigrated principal scripts but must report emitter, runner, maintenance, GUI
session monitor, tree provenance, replayable write-failure, and evidence
sidecar publishers complete.

- [ ] **Step 5: Commit event migration**

```bash
git add deploy/scripts/bot-errors-emit.py deploy/scripts/bot-errors-runner.py deploy/scripts/bot-errors-maintenance.py deploy/scripts/bot-errors-gui-session-monitor.py deploy/scripts/bot-errors-tree-provenance.py deploy/scripts/tests/test_bot_errors_emit_preflight.py tests/scripts/bot-errors-runner.test.ts deploy/bot-errors-durable-writer-inventory.json
git commit -m "fix(bot-errors): prove event publication durability"
```

### Task 5: Migrate collector and dispatcher state/event callers

**Files:**
- Modify: `deploy/scripts/bot-errors-collector.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Modify: `tests/scripts/bot-errors-collector.test.ts`
- Modify: `tests/scripts/bot-errors-dispatcher.test.ts`
- Modify: related focused Python tests named by the inventory.

**Interfaces:**
- Consumes: `observe_json`, `publish_state_json`, `publish_event_json`.
- Produces: explicit caller handling for state/event results; lifecycle moves remain owned by Draft 3.

- [ ] **Step 1: Add RED state-fence and no-advance tests**

Test each current atomic call category:

- collector state save and local outbox/quarantine/breadcrumb events;
- collector embedded remote acknowledgement journal publication, without
  changing its Draft 3 lifecycle moves;
- dispatcher incident/meta/state saves and manifest/digest/event writes.

Inject intended, predecessor, superseded, conflict, directory-open failure, sync failure, and cleanup debt. Assert no acknowledgement, suppress, clear, retry reset, terminal move, or saved-success signal occurs when `advance_allowed` is false.

- [ ] **Step 2: Run RED focused suites**

```bash
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-dispatcher.test.ts
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_bot_errors_collector_*.py deploy/scripts/tests/test_bot_errors_dispatcher_*.py
```

Expected: the new fault cases fail.

- [ ] **Step 3: Return versions from state reads**

Change state loaders used by this task to return payload plus private raw digest:

```py
state_target = durable_json_target(
    trusted_root=state_dir(),
    relative_path=state_path.relative_to(state_dir()),
)
loaded = observe_json(state_target)
state = normalize_state(loaded.payload)
```

Carry `loaded.version` to the matching save. Do not log or serialize its
private fields.

- [ ] **Step 4: Consume typed publication results**

```py
payload = redacted_collector_payload(state)
op_id = operation_id(
    state_target,
    payload,
    component="collector-state",
    predecessor=loaded.version,
)
result = publish_state_json(
    state_target,
    payload,
    component="collector-state",
    operation_id=op_id,
    expected=loaded.version,
    generation=(loaded.version.generation or 0) + 1,
)
if not result.advance_allowed:
    raise StateDurabilityBlocked(result.public_projection())
```

Use `publish_event_json` for create-once event records. Preserve #2603
controller-log behavior: bridge each `persist_controller_log_health()` adapter
to the shared result, raise a bounded exception when it cannot advance, and
let `write_controller_log()` retain its diagnostic-only classification. Migrate
embedded acknowledgement JSON journals, but do not change lifecycle
`os.replace` movers owned by #2482.

- [ ] **Step 5: Run GREEN suites and combined #2603 tests**

Run the Step 2 commands and:

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_controller_log.py deploy/scripts/tests/test_controller_log_adapters.py
```

Expected: all pass, including controller-log adapter behavior on the exact
combined #2603/#2604 dependency head.

- [ ] **Step 6: Commit collector/dispatcher migration**

```bash
git add deploy/scripts/bot-errors-collector.py deploy/scripts/bot-errors-dispatcher.py tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-dispatcher.test.ts deploy/scripts/tests deploy/bot-errors-durable-writer-inventory.json
git commit -m "fix(bot-errors): fence collector and dispatcher state"
```

### Task 6: Migrate health, watchdog, and q-loop state/event callers

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `deploy/scripts/bot-errors-heartbeat-watchdog.py`
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Modify: `deploy/scripts/bot_errors_cutover.py`
- Modify: `tests/scripts/bot-errors-heartbeat-watchdog.test.ts`
- Modify: `deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_*.py`
- Modify: `deploy/scripts/tests/test_bot_errors_q_loop_capacity_severity.py`
- Modify: additional focused health tests named by the inventory.

**Interfaces:**
- Consumes: shared versioned read and event/state publication.
- Produces: no false healthy/recovered/deadman-clear result from unproven authority.

- [ ] **Step 1: Add RED component safety tests**

Assert:

- deadman state cannot clear or report recovery after an unproven save;
- #2604's typed runtime-health dispositions and remediation ownership remain
  exact after the health-check writer migration;
- watchdog cannot clear, reset cooldown, or emit healthy after an unproven save;
- q-loop cannot report state saved/healthy after an unproven save;
- cutover repair cannot discard an unproven watchdog writer result;
- breadcrumb/event collisions do not overwrite authority; and
- private-temp debt is visible but may advance only after intended authority is proven.

Each blocked adapter emits the metadata-only surface assigned by the design:
health-check emits a bounded persistence warning, watchdog emits its
metadata-only watchdog alert, q-loop emits a bounded controller-state warning,
and controller-log diagnostic persistence degrades only that diagnostic sink.
Tests assert these diagnostics do not replace or reinterpret the domain
outcome.

- [ ] **Step 2: Run RED component suites**

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_bot_errors_health_check_*.py deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_*.py deploy/scripts/tests/test_bot_errors_q_loop_capacity_severity.py
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-heartbeat-watchdog.test.ts
```

Expected: new fault cases fail.

- [ ] **Step 3: Migrate each caller and remove inline clones**

Use components `health-state`, `health-event`, `watchdog-state`,
`watchdog-event`, and `q-loop-state`. Carry complete expected versions from
safe reads. Require `advance_allowed` before dependent state mutation or
success projection, and update the cutover repair adapter to propagate or
fail closed on the watchdog result.

- [ ] **Step 4: Run GREEN component suites**

Run the Step 2 commands.

Expected: all pass.

- [ ] **Step 5: Commit health migration**

```bash
git add deploy/scripts/bot-errors-health-check.py deploy/scripts/bot-errors-heartbeat-watchdog.py deploy/scripts/bot-errors-q-loop.py deploy/scripts/bot_errors_cutover.py deploy/scripts/tests tests/scripts/bot-errors-heartbeat-watchdog.test.ts deploy/bot-errors-durable-writer-inventory.json
git commit -m "fix(bot-errors): block unproven health state"
```

### Task 7: Migrate selfcheck and sentinel callers

**Files:**
- Modify: `deploy/scripts/bot-errors-selfcheck.py`
- Modify: `deploy/scripts/bot-errors-sentinel.py`
- Modify: `deploy/scripts/tests/test_bot_errors_selfcheck.py`
- Modify: `deploy/scripts/tests/test_bot_errors_sentinel.py`
- Modify: related sentinel/selfcheck TypeScript wrapper tests if inventory requires them.

**Interfaces:**
- Consumes: shared versioned read and event/state publication.
- Produces: explicit memory/status/heartbeat/state/digest/event/ack outcomes.

- [ ] **Step 1: Reverse the existing ignored-open-error tests**

Replace tests that currently expect `fsync_parent` open failure to be ignored. New RED assertions require `durability=unproven`, `advance_allowed=false`, no healthy/recovered status, and metadata-only bounded diagnostics.

- [ ] **Step 2: Add RED concurrency and authority tests**

Cover selfcheck memory/status dual writes and sentinel state/heartbeat/digest/ack/event writes. A first committed file followed by a second unproven file must not report the aggregate operation successful; return an explicit partial/unproven component outcome.

- [ ] **Step 3: Run RED suites**

```bash
loadgate -- python3.12 -m pytest -q deploy/scripts/tests/test_bot_errors_selfcheck.py deploy/scripts/tests/test_bot_errors_sentinel.py
```

Expected: new assertions fail.

- [ ] **Step 4: Migrate callers and aggregate multi-write outcomes**

Remove inline `fsync_parent` and `atomic_write_json`. Use explicit expected predecessor for mutable files and stable record ID for create-once files. Aggregate operations may advance only when every required write result advances.

```py
results = [
    publish_state_json(
        memory_target,
        memory_payload,
        component="selfcheck-memory",
        operation_id=operation_id(
            memory_target,
            memory_payload,
            component="selfcheck-memory",
            predecessor=memory_loaded.version,
        ),
        expected=memory_loaded.version,
        generation=(memory_loaded.version.generation or 0) + 1,
    ),
    publish_state_json(
        status_target,
        status_payload,
        component="selfcheck-status",
        operation_id=operation_id(
            status_target,
            status_payload,
            component="selfcheck-status",
            predecessor=status_loaded.version,
        ),
        expected=status_loaded.version,
        generation=(status_loaded.version.generation or 0) + 1,
    ),
]
if not all(result.advance_allowed for result in results):
    raise SelfcheckPersistenceBlocked(public_aggregate(results))
```

- [ ] **Step 5: Run GREEN suites**

Run the Step 3 command.

Expected: all pass.

- [ ] **Step 6: Commit selfcheck/sentinel migration**

```bash
git add deploy/scripts/bot-errors-selfcheck.py deploy/scripts/bot-errors-sentinel.py deploy/scripts/tests/test_bot_errors_selfcheck.py deploy/scripts/tests/test_bot_errors_sentinel.py deploy/bot-errors-durable-writer-inventory.json
git commit -m "fix(bot-errors): prove selfcheck and sentinel writes"
```

### Task 8: Enforce the inventory and coherent runtime bundle

**Files:**
- Modify: `deploy/scripts/check-bot-errors-durable-writers.py`
- Modify: `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `deploy/scripts/whatsoup-bot-errors-deploy.sh`
- Modify: `scripts/check-bot-errors-runtime-manifest.ts`
- Modify: `tests/scripts/check-bot-errors-runtime-manifest.test.ts`
- Create: `deploy/scripts/lib/durable_json_remote.py`
- Create: `deploy/scripts/generate-bot-errors-remote-durability.py`
- Create/modify: embedded byte-and-behavior parity tests.
- Modify: deployer/installer parity tests.

**Interfaces:**
- Produces: exact helper-generation coupling, isolated installed imports, mixed-version rejection, and rollback to a coherent prior bundle.

- [ ] **Step 1: Make the structural guard terminal-green**

The final guard must prove:

- exactly nine principal scripts;
- every cooperating same-root script and embedded publisher is classified;
- zero inline atomic JSON clones;
- every inventoried helper call exists;
- every helper result is consumed;
- no principal best-effort call;
- no unclassified call in any protected-root publisher;
- allowed lifecycle `os.replace` movers remain explicitly outside Draft 1; and
- fault-matrix test IDs exist for every inventory row/category.
- one table-driven meta-test injects an unproven result into every principal
  and cooperating adapter and proves none emits queued, saved, healthy,
  recovered, acknowledged, suppressed, cleared, or terminal success.

- [ ] **Step 2: Add RED manifest/deployer tests**

Assert failure for missing helper, missing inventory generation, helper/script generation mismatch, stale hash, installed bundle missing the helper, source-tree-only import success, and rollback bundle missing a coherent generation.
Preserve both dependency additions: `controller_log.py` from #2603 and the
fault-taxonomy registry required by #2604. Derive managed-file counts from the
manifest file set; do not hardcode 12, 13, 14, or 15. Add combined cases for:

- diagnostic append failure plus an unproven controller-log health receipt;
- registry-valid plus durability-unproven;
- registry-invalid plus durability-committed;
- both failures remaining independently visible and bounded; and
- isolated installed-bundle imports containing all three new runtime
  dependencies.

- [ ] **Step 3: Generate and prove embedded remote parity**

Keep `durable_json_remote.py` restricted to the runtime-safe subset needed by
the embedded acknowledgement journals. The deterministic generator serializes
that checked-in source into collector's embedded scripts. Tests must prove:

- generated bytes are current and deterministic;
- the embedded state-machine outcomes match the local helper for the shared
  event/state, ambiguity, cleanup, and parent-barrier vectors;
- an ignored remote `fsync_dir()` open failure is impossible; and
- a remote lifecycle move remains explicitly Draft-3-owned and cannot report
  success from a failed barrier.

- [ ] **Step 4: Register the helper generation**

Add `deploy/scripts/lib/durable_json.py` to:

- runtime manifest with exact SHA-256 and required generation marker;
- runtime required-file inventory;
- deploy bundle;
- rollback/last-known-good coherent bundle checks; and
- isolated installed-bundle import test.

Generation `1` is the initial contract generation, not a content-derived
value. Any change to the public helper contract, serialized remote subset, or
outcome semantics must increment the integer atomically in the helper,
inventory, manifest, generated remote bytes, and all adapters. The guard
rejects missing, stale, or mixed values. Local migrated scripts import the
installed helper; embedded scripts use only the generated remote subset.

- [ ] **Step 5: Run guard and packaging suites**

```bash
python3.12 deploy/scripts/check-bot-errors-durable-writers.py --inventory deploy/bot-errors-durable-writer-inventory.json
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/check-bot-errors-runtime-manifest.test.ts tests/scripts/deployer-static-parity.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-critical-surface-audit.test.ts
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-runtime-manifest
bash scripts/run-with-pinned-npm.sh run guard:deployer-static
```

Expected: all pass.

The exact helper/concurrency matrix must run on both the hosted Linux quality
lane and the macOS BOT ERRORS health lane. A platform skip or unavailable
capability is an inconclusive platform result, not cross-platform proof.

- [ ] **Step 6: Commit packaging and guard**

```bash
git add deploy/bot-errors-durable-writer-inventory.json deploy/scripts/check-bot-errors-durable-writers.py deploy/scripts/lib/durable_json_remote.py deploy/scripts/generate-bot-errors-remote-durability.py tests/scripts/bot-errors-python-atomic-write-guard.test.ts deploy/bot-errors-runtime-manifest.json deploy/scripts/whatsoup-bot-errors-deploy.sh scripts/check-bot-errors-runtime-manifest.ts tests/scripts deploy/scripts/tests
git commit -m "chore(bot-errors): pin durable writer generation"
```

### Task 9: Full verification, independent review, draft PR, and truthful issue lifecycle

**Files:**
- Modify only files required by verified review findings.

**Interfaces:**
- Produces: exact-head non-closing draft PR advancing #2485, with truthful
  unchanged issue lifecycle state.

- [ ] **Step 1: Run the complete BOT ERRORS suites**

```bash
loadgate -- bash deploy/scripts/run-bot-errors-full-suite.sh
loadgate -- bash deploy/scripts/run-sentinel-tests.sh
loadgate -- bash scripts/run-with-pinned-npm.sh test -- --run tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/check-bot-errors-runtime-manifest.test.ts tests/scripts/deployer-static-parity.test.ts tests/scripts/bot-errors-release-proof-installer.test.ts tests/scripts/bot-errors-critical-surface-audit.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-heartbeat-watchdog.test.ts
```

Expected: all pass with exact counts recorded.

- [ ] **Step 2: Run static/type/publication gates**

```bash
python3.12 -m compileall -q deploy/scripts/lib/durable_json.py deploy/scripts/check-bot-errors-durable-writers.py
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Run two independent cross-runtime double-blind reviews**

Provide each reviewer the full diff plus helper, inventory, nine callers,
focused tests, manifest, and deployer context. Require severity, path/line
evidence, strongest falsifier, missing context, confidence, and lead checks.
Use only code-review-capable lanes for code/diff judgment. Run a separate
test-integrity worker over all changed tests.

- [ ] **Step 4: Health-check a separate prose-only evidence-review lane**

```bash
ocw-health --json --timeout 20 <configured-prose-review-lane>
```

Use the lane only if the functional canary is healthy, and only for
prose/evidence completeness—not code/diff judgment. If unhealthy, record the
lane as unavailable without substitution.

- [ ] **Step 5: Verify and resolve accepted findings**

For each accepted finding: inspect source, add a failing test, implement the minimal fix, rerun the focused suite, and commit. Reject unsupported findings with source evidence.

- [ ] **Step 6: Run the enforced exact-head branch gate**

```bash
loadgate -- bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: terminal pass with no masked subcheck.

- [ ] **Step 7: Revalidate live ownership and collision state**

Re-read #2485, #2464, #2603, #2604, current main, every open PR
changed-file page, and the implementation branch head. If either dependency
changed or merged, rebuild the combined base deliberately and rerun
`git range-diff`, `git cherry -v`, all focused suites, and the branch gate.

- [ ] **Step 8: Scan all public surfaces**

Scan commit subjects/authors, diff-added lines, final PR title/body, and planned
issue comment. Reject private/local values, attribution, secret-like text, and
closing references. Both #2485 and #2464 are non-closing references.

- [ ] **Step 9: Push over SSH and create a draft PR**

Never publish a PR against the private synthetic integration branch. Open the
draft only after either:

- exact main contains both accepted dependencies; or
- the dependency owners have established one public reviewed stack containing
  both, in which case use its top branch as the draft base.

If #2603 and #2604 remain independent sibling PRs, implementation and testing
may continue locally but draft publication is blocked. Once a publishable base
exists, the PR body includes:

- exact base/head;
- #2485 ownership and non-closing #2464 scope;
- #2603 and #2604 collision resolution;
- nine-writer inventory;
- result/advance contract;
- RED/GREEN fault matrix;
- exact reproduction commands and counts;
- unsupported-platform limitations;
- rollback/safe-stop behavior; and
- public-surface scan evidence.

- [ ] **Step 10: Verify hosted checks at exact head**

Wait for Node 24, Node 25, macOS health, performance, CodeQL, and security analysis. A failure or masked check blocks lifecycle transition.

- [ ] **Step 11: Preserve the exact issue lifecycle**

After all Draft 1 writers, local gates, reviews, and hosted checks are
reproducibly green:

1. add a direct metadata-safe comment on #2485 linking the partial draft and
   naming the Draft 3 residual without private details;
2. confirm GitHub's automatic timeline backlink separately;
3. verify #2485 remains exclusively `IN PROGRESS`;
4. verify #2464 remains exclusively `IN PROGRESS`;
5. do not add `PATCH READY` to either issue; and
6. do not change #2427, #2482, #2463, or #2429.

Draft 3 owns any later #2485 transition after the embedded cross-parent
residual is implemented and independently validated.
