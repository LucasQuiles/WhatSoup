from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from hypothesis import example, given, strategies as st

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from bot_errors_property_support import properties  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.incident_authority import (  # noqa: E402
    AuthorityConflict,
    AuthorityNotReady,
    AuthorityProtocolError,
    AuthorityUnavailable,
    IncidentAuthorityClient,
    canonical_signal,
)


CLAIM = {
    "schemaVersion": 1,
    "id": "event-1",
    "eventType": "alert",
    "severity": "critical",
    "createdAt": "2026-10-13T12:00:00Z",
    "machine": "host-a",
    "instance": "health",
    "source": "selfcheck",
    "summary": "private operator text",
    "evidence": "private evidence",
}


class _Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = {str(k).lower(): str(v) for k, v in headers.items()}
        self.body = body

    def read(self, limit):
        return self.body[:limit]

    def getheader(self, name):
        return self.headers.get(name.lower())


class _Connection:
    def __init__(self, response):
        self.response_builder = response
        self.requests: list[dict[str, object]] = []
        self.response = None

    def request(self, method, path, body, headers):
        self.requests.append({"method": method, "path": path, "body": body, "headers": headers})
        status, response_headers, payload = self.response_builder(body)
        self.response = _Response(status, response_headers, payload)

    def getresponse(self):
        return self.response

    def close(self):
        return


@contextmanager
def _private_credential_root() -> Iterator[Path]:
    # The credential reader opens every parent without following a link and
    # requires each to be private to the user, so this folder sits under the
    # home folder, not the system temporary folder.
    with TemporaryDirectory(prefix="whatsoup-incident-authority-", dir=Path.home()) as directory:
        root = Path(directory)
        root.chmod(0o700)
        yield root


def _write_credential(root: Path) -> Path:
    path = root / "incident-authority.credential"
    path.write_text("narrow-secret\n", encoding="utf-8")
    path.chmod(0o600)
    return path


@pytest.fixture
def private_credential_root() -> Iterator[Path]:
    with _private_credential_root() as root:
        yield root


@pytest.fixture
def credential(private_credential_root: Path) -> Path:
    return _write_credential(private_credential_root)


def _client(response, credential):
    connection = _Connection(response)
    client = IncidentAuthorityClient(
        "http://127.0.0.1:7419/api/signals",
        credential,
        expected_producer_id="bot-errors-dispatcher",
        connection_factory=lambda _host, _port, _timeout: connection,
    )
    return client, connection


def _receipt(body: bytes, *, signal_id: str = "be-event-1") -> bytes:
    return json.dumps(
        {
            "schemaVersion": 1,
            "receiptId": "rcpt-7",
            "eventId": 7,
            "producerId": "bot-errors-dispatcher",
            "signalId": signal_id,
            "payloadDigest": f"sha256:{hashlib.sha256(body).hexdigest()}",
            "receivedAt": "2026-10-13T12:00:01.000Z",
            "disposition": "incident_opened",
            "incidentId": 4,
            "transitionId": 9,
        },
        separators=(",", ":"),
    ).encode()


def test_canonical_signal_is_byte_stable_and_content_free():
    first = canonical_signal(CLAIM)
    changed_delivery = canonical_signal({
        **CLAIM,
        "severity": "error",
        "summary": "dispatcher escalation summary",
        "evidence": "dispatcher escalation evidence",
        "delivery": {"attempts": 99, "lastError": "secret"},
    })
    assert first.body == changed_delivery.body
    assert first.signal_id == "be-event-1"
    text = first.body.decode()
    assert "private operator text" not in text
    assert "private evidence" not in text
    assert "host-a" not in text
    assert "critical" not in text
    assert json.loads(text)["kind"] == "condition_observed"


def test_canonical_signal_accepts_a_persisted_legacy_observation_time():
    legacy = {**CLAIM, "authorityObservedAt": CLAIM["createdAt"]}
    legacy.pop("createdAt")
    assert canonical_signal(legacy).body == canonical_signal(CLAIM).body


def test_occurrence_sequence_is_safe_and_strictly_orders_adjacent_milliseconds():
    earlier = canonical_signal({
        **CLAIM,
        "id": "id-4601",
        "createdAt": "2026-10-13T12:00:00.000Z",
    })
    later = canonical_signal({
        **CLAIM,
        "id": "id-7445",
        "createdAt": "2026-10-13T12:00:00.001Z",
    })
    earlier_seq = json.loads(earlier.body)["occurrenceSeq"]
    later_seq = json.loads(later.body)["occurrenceSeq"]
    assert earlier_seq < later_seq
    assert later_seq <= (2**53) - 1


def test_accepts_bound_201_receipt_before_returning_grant(credential: Path):
    client, connection = _client(
        lambda body: (201, {"Content-Type": "application/json"}, _receipt(body)), credential
    )
    grant = client.accept(CLAIM)
    assert grant.receipt_id == "rcpt-7"
    assert grant.incident_id == 4
    assert connection.requests[0]["headers"]["Authorization"] == "Bearer narrow-secret"


def test_accepts_exact_200_replay_only_with_header(credential: Path):
    client, _ = _client(
        lambda body: (200, {"Content-Type": "application/json", "Idempotent-Replay": "true"}, _receipt(body)),
        credential,
    )
    assert client.accept(CLAIM).replay is True


def test_rejects_mismatched_receipt_and_200_without_replay_header(credential: Path):
    for response in (
        lambda body: (201, {"Content-Type": "application/json"}, _receipt(body, signal_id="other")),
        lambda body: (200, {"Content-Type": "application/json"}, _receipt(body)),
    ):
        client, _ = _client(response, credential)
        with pytest.raises(AuthorityProtocolError):
            client.accept(CLAIM)


def test_classifies_conflict_terminal_and_store_failure_retryable(credential: Path):
    cases = [(409, AuthorityConflict), (503, AuthorityUnavailable), (507, AuthorityUnavailable)]
    for status_code, error in cases:
        client, _ = _client(
            lambda _body, code=status_code: (code, {"Content-Type": "application/json"}, b"{}"),
            credential,
        )
        with pytest.raises(error):
            client.accept(CLAIM)


def test_rejects_redirect_without_forwarding_credential(credential: Path):
    client, connection = _client(
        lambda _body: (302, {"Location": "http://127.0.0.1:1/steal"}, b""), credential
    )
    with pytest.raises(AuthorityProtocolError):
        client.accept(CLAIM)
    assert len(connection.requests) == 1


def test_credential_contract_rejects_symlink_fifo_public_mode_and_oversize(
    private_credential_root: Path,
):
    real = private_credential_root / "real"
    real.write_text("secret\n")
    real.chmod(0o600)
    symlink = private_credential_root / "link"
    symlink.symlink_to(real)
    public = private_credential_root / "public"
    public.write_text("secret\n")
    public.chmod(0o644)
    fifo = private_credential_root / "fifo"
    os.mkfifo(fifo, 0o600)
    huge = private_credential_root / "huge"
    huge.write_text("x" * 5000)
    huge.chmod(0o600)
    public_parent = private_credential_root / "public-parent"
    public_parent.mkdir(mode=0o700)
    parent_credential = public_parent / "credential"
    parent_credential.write_text("secret\n")
    parent_credential.chmod(0o600)
    public_parent.chmod(0o777)

    cases = (
        (symlink, "authority_credential_unreadable"),
        (public, "authority_credential_not_private"),
        (fifo, "authority_credential_not_regular"),
        (huge, "authority_credential_oversized"),
        (parent_credential, "authority_credential_parent_not_private"),
    )
    for path, expected_error in cases:
        client = IncidentAuthorityClient(
            "http://127.0.0.1:1/api/signals",
            path,
            expected_producer_id="bot-errors-dispatcher",
        )
        # A local credential problem is "not ready": nothing is sent and the
        # protected effect waits, but it is never a terminal protocol error.
        with pytest.raises(AuthorityNotReady, match=rf"^{expected_error}$"):
            client.accept(CLAIM)


def test_destination_contract_rejects_userinfo_query_fragment_and_nonlocal_http(credential: Path):
    for url in (
        "http://user:pass@127.0.0.1:1/api/signals",
        "http://127.0.0.1:1/api/signals?token=x",
        "http://127.0.0.1:1/api/signals#frag",
        "http://example.com/api/signals",
        "http://127.0.0.1:1/other",
    ):
        with pytest.raises(AuthorityNotReady):
            IncidentAuthorityClient(url, credential, expected_producer_id="bot-errors-dispatcher")


def test_missing_credential_file_is_not_ready(private_credential_root: Path):
    client = IncidentAuthorityClient(
        "http://127.0.0.1:1/api/signals",
        private_credential_root / "not-enrolled-yet",
        expected_producer_id="bot-errors-dispatcher",
    )
    with pytest.raises(AuthorityNotReady, match=r"^authority_credential_unreadable$"):
        client.accept(CLAIM)


def test_refused_credential_scope_and_rate_are_not_ready(credential: Path):
    cases = (
        (401, "authority_credential_rejected"),
        (403, "authority_scope_denied"),
        (429, "incident_authority_rate_limited"),
    )
    for status_code, reason in cases:
        client, _ = _client(
            lambda _body, code=status_code: (code, {"Content-Type": "application/json"}, b"{}"),
            credential,
        )
        with pytest.raises(AuthorityNotReady, match=rf"^{reason}$"):
            client.accept(CLAIM)


def test_store_and_transport_failures_are_not_ready(credential: Path):
    # An outage of the authority holds the work; it must never dead-letter it.
    for status_code in (500, 503, 507):
        client, _ = _client(
            lambda _body, code=status_code: (code, {"Content-Type": "application/json"}, b"{}"),
            credential,
        )
        with pytest.raises(AuthorityNotReady, match=r"^incident_authority_unavailable$"):
            client.accept(CLAIM)

    def _refused(_body):
        raise ConnectionRefusedError("authority down")

    client, _ = _client(_refused, credential)
    with pytest.raises(AuthorityNotReady, match=r"^incident_authority_unavailable$"):
        client.accept(CLAIM)


# Every status that is a refusal or an outage, with the reason it raises.
# Every 5xx status is an outage.
_REFUSAL_STATUSES = st.one_of(
    st.sampled_from(
        (
            (401, "authority_credential_rejected"),
            (403, "authority_scope_denied"),
            (429, "incident_authority_rate_limited"),
        )
    ),
    st.integers(min_value=500, max_value=599).map(lambda code: (code, "incident_authority_unavailable")),
)


@properties
@given(refusal=_REFUSAL_STATUSES)
@example(refusal=(401, "authority_credential_rejected"))
@example(refusal=(403, "authority_scope_denied"))
@example(refusal=(429, "incident_authority_rate_limited"))
@example(refusal=(503, "incident_authority_unavailable"))
def test_an_oversized_refusal_is_classified_by_its_status(refusal):
    status_code, reason = refusal
    # A proxy's large error page must not turn a refusal or an outage into a
    # protocol error: the status decides before the body size does.
    oversized = b"x" * (16 * 1024 + 1)
    with _private_credential_root() as root:
        client, _ = _client(
            lambda _body, code=status_code: (code, {"Content-Type": "text/html"}, oversized),
            _write_credential(root),
        )
        with pytest.raises(AuthorityNotReady, match=rf"^{reason}$"):
            client.accept(CLAIM)


class _SlowConnection:
    """Accepts the request, then holds the reply until it is closed."""

    def __init__(self, delay: float):
        self.delay = delay
        self.closed = threading.Event()

    def request(self, method, path, body, headers):
        return

    def getresponse(self):
        self.closed.wait(self.delay)
        raise TimeoutError("no reply")

    def close(self):
        self.closed.set()


def test_an_observe_deadline_bounds_the_whole_request(credential: Path):
    connection = _SlowConnection(delay=5.0)
    timeouts: list[float] = []
    client = IncidentAuthorityClient(
        "http://127.0.0.1:7419/api/signals",
        credential,
        expected_producer_id="bot-errors-dispatcher",
        connection_factory=lambda _host, _port, timeout: timeouts.append(timeout) or connection,
    )
    started = time.monotonic()
    with pytest.raises(AuthorityNotReady, match=r"^incident_authority_unavailable$"):
        client.accept(CLAIM, deadline_seconds=0.3)
    assert time.monotonic() - started < 1.5, "the caller waits no longer than the deadline"
    assert timeouts == [0.3], "no socket operation may wait past the deadline"
    assert connection.closed.wait(1.0), "the abandoned request is closed"


class _BodylessResponse(_Response):
    def read(self, limit):
        raise TimeoutError("body never arrived")


class _BodylessConnection(_Connection):
    def request(self, method, path, body, headers):
        status, response_headers, _payload = self.response_builder(body)
        self.response = _BodylessResponse(status, response_headers, b"")


@pytest.mark.parametrize("deadline", [None, 1.0])
def test_a_rate_limit_is_recognised_when_its_body_never_arrives(credential: Path, deadline):
    connection = _BodylessConnection(lambda _body: (429, {"Content-Type": "application/json"}, b""))
    client = IncidentAuthorityClient(
        "http://127.0.0.1:7419/api/signals",
        credential,
        expected_producer_id="bot-errors-dispatcher",
        connection_factory=lambda _host, _port, _timeout: connection,
    )
    kwargs = {} if deadline is None else {"deadline_seconds": deadline}
    with pytest.raises(AuthorityNotReady, match=r"^incident_authority_rate_limited$"):
        client.accept(CLAIM, **kwargs)


def test_an_oversized_success_reply_stays_a_protocol_error(credential: Path):
    oversized = b"x" * (16 * 1024 + 1)
    client, _ = _client(
        lambda _body: (201, {"Content-Type": "application/json"}, oversized),
        credential,
    )
    with pytest.raises(AuthorityProtocolError, match=r"^authority_response_oversized$"):
        client.accept(CLAIM)


def _authority_lib():
    import lib.incident_authority as authority

    return authority


def _documented_mode(value: str | None) -> tuple[str | None, str, bool]:
    # The reader's documented rule: after trimming white space, exactly
    # "observe" or "enforce" is that mode; absent or empty is observe; any
    # other value is observe with one warning.
    trimmed = (value or "").strip()
    if trimmed in ("observe", "enforce"):
        return value, trimmed, False
    return value, "observe", bool(trimmed)


_PADDING = st.sampled_from(("", " ", "\t", "\n", " \r\n"))
_MODE_SETTINGS = st.one_of(
    st.none(),
    st.text(max_size=16),
    st.builds(
        lambda before, word, after: before + word + after,
        _PADDING,
        st.sampled_from(("observe", "enforce", "Enforce", "OBSERVE", "enforced", "on", "off")),
        _PADDING,
    ),
).map(_documented_mode)


@properties
@given(setting=_MODE_SETTINGS)
@example(setting=(None, "observe", False))
@example(setting=("", "observe", False))
@example(setting=("   ", "observe", False))
@example(setting=("observe", "observe", False))
@example(setting=("enforce", "enforce", False))
@example(setting=(" enforce\n", "enforce", False))
@example(setting=("Enforce", "observe", True))
@example(setting=("on", "observe", True))
def test_the_mode_reader_defaults_to_observe(setting):
    value, mode, warned = setting
    authority = _authority_lib()
    environ = {} if value is None else {authority.AUTHORITY_MODE_SETTING: value}
    warnings: list[str] = []
    assert authority.incident_authority_mode(environ, warnings.append) == mode
    assert warnings == (["incident_authority_mode_unknown"] if warned else [])
    assert authority.AUTHORITY_MODE_SETTING == "BOT_ERRORS_INCIDENT_AUTHORITY_MODE"


def _never_a_code(text: str) -> str:
    # A space is outside every reason code, so this text must never reach a record.
    return f"{text} x"


_ANY_TEXT = st.text(max_size=24)
_FREE_TEXT = _ANY_TEXT.map(_never_a_code)
# Any answer, as (error, outcome, reason): free text in a reason-carrying error,
# any message on an error whose class alone decides, and any exception the
# client did not classify.
_AUTHORITY_ANSWERS = st.one_of(
    _FREE_TEXT.map(lambda text: (AuthorityProtocolError(text), "protocol_error", "authority_client_error")),
    _FREE_TEXT.map(lambda text: (AuthorityNotReady(text), "not_ready", "authority_client_error")),
    _ANY_TEXT.map(lambda text: (AuthorityConflict(text), "refused", "incident_authority_identity_conflict")),
    _ANY_TEXT.map(lambda text: (AuthorityUnavailable(text), "not_ready", "incident_authority_unavailable")),
    st.builds(
        lambda error_type, text: (error_type(text), "protocol_error", "authority_client_error"),
        st.sampled_from((TypeError, ValueError, KeyError, OSError, RuntimeError, LookupError)),
        _ANY_TEXT,
    ),
)


@properties
@given(answer=_AUTHORITY_ANSWERS)
@example(answer=(None, "granted", "none"))
@example(answer=(AuthorityConflict("incident_authority_identity_conflict"), "refused", "incident_authority_identity_conflict"))
@example(answer=(AuthorityNotReady("authority_credential_rejected"), "refused", "authority_credential_rejected"))
@example(answer=(AuthorityNotReady("authority_scope_denied"), "refused", "authority_scope_denied"))
@example(answer=(AuthorityNotReady("incident_authority_rate_limited"), "not_ready", "incident_authority_rate_limited"))
@example(answer=(AuthorityNotReady("incident_authority_unavailable"), "not_ready", "incident_authority_unavailable"))
@example(answer=(AuthorityNotReady("authority_credential_unreadable"), "not_ready", "authority_credential_unreadable"))
@example(answer=(AuthorityNotReady("incident_authority_not_configured"), "not_configured", "incident_authority_not_configured"))
@example(answer=(AuthorityProtocolError("authority_receipt_malformed"), "protocol_error", "authority_receipt_malformed"))
@example(answer=(TypeError("unhashable type: 'list'"), "protocol_error", "authority_client_error"))
@example(answer=(OSError("read failed on /private/path"), "protocol_error", "authority_client_error"))
@example(answer=(AuthorityProtocolError("contains a path /private/state and spaces"), "protocol_error", "authority_client_error"))
def test_outcomes_are_classified_into_closed_codes(answer):
    error, outcome, reason = answer
    authority = _authority_lib()
    assert authority.classify_authority_outcome(error) == (outcome, reason)


def test_the_outcome_record_carries_only_closed_fields():
    authority = _authority_lib()
    record = authority.authority_outcome_record(
        event_class="alert",
        outcome="refused",
        reason="authority_scope_denied",
        mode="observe",
        observed_epoch=1_763_600_000,
    )
    assert record == {
        "time": "2025-11-20T00:53:20Z",
        "eventClass": "alert",
        "outcome": "refused",
        "reason": "authority_scope_denied",
        "mode": "observe",
    }
    unsafe = authority.authority_outcome_record(
        event_class="host-a private summary",
        outcome="whatever",
        reason="text with /private/state",
        mode="loud",
        observed_epoch=1_763_600_000,
    )
    assert unsafe["eventClass"] == "other"
    assert unsafe["outcome"] == "protocol_error"
    assert unsafe["reason"] == "authority_client_error"
    assert unsafe["mode"] == "observe"
