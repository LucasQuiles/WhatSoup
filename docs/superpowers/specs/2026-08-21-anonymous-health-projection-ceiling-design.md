# Anonymous Health Projection Ceiling Design

**PR:** #3332

**Status:** IMPLEMENTED on PR #3332 (round-4 head `e789ba635`, two-site repair; verified by executed falsifier — anonymous trio WARN, zero verdict-marker leakage, controls intact). This record is design provenance.

**Canonical design baseline:** `066041258e0c1f43338f9e2a8e12c0ebf4934e59`

## Goal

Prevent an unauthenticated health response from producing a workload verdict.
Anonymous responses may prove that the local HTTP endpoint answered and may
surface token or disclosure configuration debt, but their body fields may not
claim that the workload is healthy, degraded, or unhealthy.

The repair must preserve true-down detection. A connection-refused probe still
fails because it is direct transport evidence rather than a verdict derived
from an unauthenticated response body.

## Proven Defect

An anonymous diagnostic-shaped response currently crosses the authority
ceiling through two independent paths in
`deploy/scripts/bot-errors-health-check.py`:

1. `health_probe_details()` reduces the body to `schema_version`, `status`,
   and `generated_at`, then continues evaluating those untrusted fields when
   the diagnostic schema does not satisfy `is_public_envelope()`. A spoofable
   `status=unhealthy` therefore emits `health_unhealthy`; related status and
   timestamp verdict markers can leak through the same path.
2. `format_health_probe()` exempts public and token-rejected responses from
   the raw HTTP 5xx failure rule, but does not exempt an anonymous
   `health_projection=unobserved` response. HTTP 503 therefore produces
   `FAIL` even after body-derived verdicts are removed.

The deterministic falsifier at the design baseline returns:

```text
FAIL 503 ... health_unhealthy health_unauthenticated_disclosure
health_token_missing health_projection=unobserved status=unhealthy
```

Existing tests cover anonymous public 503 and token-rejected 503. They do not
cover an anonymous diagnostic-shaped 200 or 503 response.

## Selected Two-Site Repair

### 1. Stop body evaluation at the authority boundary

After projection classification and configuration-marker collection,
`health_probe_details()` returns immediately for every response where no
token was sent and the projection is not diagnostic.

Before returning it may retain only:

- `health_projection=public|unobserved`;
- `health_token_missing`, when applicable; and
- `health_unauthenticated_disclosure`, when an anonymous response has the
  privileged diagnostic shape.

It must not evaluate or emit body-derived status, freshness, identity,
authentication, database, provider, or runtime-agent markers. In particular,
anonymous bodies cannot emit `health_unhealthy`, `health_degraded`,
`health_status_*`, `health_generated_at_*`, or
`health_identity_mismatch`.

### 2. Make severity classification honor the same boundary

`format_health_probe()` treats every anonymous non-diagnostic projection as
non-diagnostic for the raw HTTP 5xx rule. A diagnostic-shaped anonymous 503 is
therefore WARN, not FAIL.

`health_unauthenticated_disclosure` is explicitly WARN-class configuration
debt. This remains visible even at HTTP 200 and even if no other warning marker
is present.

Anonymous 401/403 responses are also WARN-class configuration evidence: the
endpoint requires authentication, and the missing or rejected token must be
repaired, but the response is not a workload failure. The early authority
return must therefore prevent `health_probe_auth_failed` from being derived
from an anonymous body.

## Behavior Matrix

| Observation | Required result |
|---|---|
| Anonymous public 200/503 | Existing liveness-only behavior; never a body-derived workload verdict |
| Anonymous diagnostic-shaped 200 | WARN with projection/disclosure markers; no privileged or verdict-bearing markers |
| Anonymous diagnostic-shaped 503 | WARN, not FAIL; same marker ceiling as anonymous 200 |
| Anonymous diagnostic-shaped 401/403 | WARN, not FAIL; auth-required endpoint plus token/configuration debt, with no body-derived workload verdict |
| Token missing | Probe still occurs; WARN when the endpoint answers |
| Token sent but rejected | Existing WARN-class unobserved behavior remains |
| Authenticated diagnostic response | Existing status, freshness, identity, auth, database, provider, and runtime evaluation remains |
| Connection refused or transport error | FAIL remains; true-down detection is unchanged |

## Rejected Alternatives

### Severity-only exemption

Rejected because it suppresses the prefix while still parsing and emitting
untrusted body-derived verdict markers.

### Dependency injection or reader redesign

Rejected as unnecessary scope expansion. The defect is fully contained at the
existing projection and severity boundaries.

### Early return without the 5xx exemption

Rejected because the raw HTTP status would still force FAIL independently of
the body-derived markers.

## TDD and Verification

Add regression coverage before production edits:

1. Anonymous diagnostic-shaped 200 emits WARN with
   `health_unauthenticated_disclosure` and no verdict-bearing or privileged
   markers.
2. Anonymous diagnostic-shaped 503 emits WARN, not FAIL, with the same ceiling.
3. Anonymous diagnostic-shaped 401 and 403 emit WARN, not FAIL, and do not emit
   `health_probe_auth_failed` or other body-derived verdict markers.
4. The RED run must fail on the current exact PR head for the expected prefix
   and leaked markers.
5. After the minimal two-site repair, rerun the focused Python projection
   tests, the complete TypeScript BOT ERRORS health suite, deploy Python tests,
   the BOT ERRORS runtime-manifest guard, and required Test Integrity.
6. Re-run the connection-refused/down-detection test explicitly to prove the
   repair did not mask true-down evidence.

No passing result may be carried across a changed PR head without exact
test-blob identity.

## Non-Goals

- Changing token resolution, authenticated diagnostic semantics, or the public
  health schema.
- Treating an anonymous response body as proof of workload health.
- Weakening connection-refused or transport-error failures.
- Refactoring the shared health reader or adding a new abstraction.
- Merging, pushing, or changing #3332's owner-gated publication policy.

## Delivery Boundary

Implementation occurs on the isolated local branch
`fix/pr3332-anonymous-projection-ceiling` based on the exact PR head above.
The result is a locally verified commit for the owning lane to inspect and
harvest. It does not mutate the remote PR branch and does not authorize merge.
