from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib.incident_authority import (
    AuthorityConflict,
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


@pytest.fixture
def credential(tmp_path: Path) -> Path:
    path = tmp_path / "incident-authority.credential"
    path.write_text("narrow-secret\n", encoding="utf-8")
    path.chmod(0o600)
    return path


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


def test_credential_contract_rejects_symlink_fifo_public_mode_and_oversize(tmp_path: Path):
    real = tmp_path / "real"
    real.write_text("secret\n")
    real.chmod(0o600)
    symlink = tmp_path / "link"
    symlink.symlink_to(real)
    public = tmp_path / "public"
    public.write_text("secret\n")
    public.chmod(0o644)
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo, 0o600)
    huge = tmp_path / "huge"
    huge.write_text("x" * 5000)
    huge.chmod(0o600)
    public_parent = tmp_path / "public-parent"
    public_parent.mkdir(mode=0o700)
    parent_credential = public_parent / "credential"
    parent_credential.write_text("secret\n")
    parent_credential.chmod(0o600)
    public_parent.chmod(0o777)

    for path in (symlink, public, fifo, huge, parent_credential):
        client = IncidentAuthorityClient(
            "http://127.0.0.1:1/api/signals",
            path,
            expected_producer_id="bot-errors-dispatcher",
        )
        with pytest.raises(AuthorityProtocolError):
            client.accept(CLAIM)


def test_destination_contract_rejects_userinfo_query_fragment_and_nonlocal_http(credential: Path):
    for url in (
        "http://user:pass@127.0.0.1:1/api/signals",
        "http://127.0.0.1:1/api/signals?token=x",
        "http://127.0.0.1:1/api/signals#frag",
        "http://example.com/api/signals",
        "http://127.0.0.1:1/other",
    ):
        with pytest.raises(AuthorityProtocolError):
            IncidentAuthorityClient(url, credential, expected_producer_id="bot-errors-dispatcher")
