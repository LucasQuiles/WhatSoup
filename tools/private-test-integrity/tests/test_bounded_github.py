"""Exercise API confinement and failures without network access or credentials."""

import base64
import io
import hashlib
from http.client import IncompleteRead
import json
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request

from bounded_github import GitHubClient
from bounded_github import MAX_BLOB_BATCH_BYTES, _verify_blob_batch_response
from private_scanner_candidate import BoundaryError


class Response(io.BytesIO):
    def __init__(self, raw, *, status=200, headers=None):
        super().__init__(raw)
        self.status = status
        self.headers = headers or {"Content-Type": "application/json"}
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        response = self.response.pop(0) if isinstance(self.response, list) else self.response
        if isinstance(response, Exception):
            raise response
        return response


def git_blob_oid(content):
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


def graphql_blob_response(objects, *, errors=None, repository="LucasQuiles/WhatSoup"):
    payload = {
        "data": {
            "repository": {
                "nameWithOwner": repository,
                **{
                    f"b{index}": {
                        "__typename": "Blob",
                        "oid": object_id,
                        "byteSize": len(content),
                        "isBinary": False,
                        "isTruncated": False,
                        "text": content.decode("utf-8"),
                    }
                    for index, (object_id, content) in enumerate(objects)
                },
            },
        },
    }
    if errors is not None:
        payload["errors"] = errors
    return json.dumps(payload).encode()


class GitHubTransportTests(unittest.TestCase):
    def client(self, raw=b'{"ok":true}', **kwargs):
        response = Response(raw, status=kwargs.pop("status", 200), headers=kwargs.pop("headers", None))
        opener = FakeOpener(response)
        return GitHubClient("fixture-token", opener=opener, **kwargs), response, opener

    def test_get_is_scoped_authenticated_and_bounded(self):
        client, response, opener = self.client(max_response_bytes=128, timeout_seconds=7)
        self.assertEqual(client.get_json("git/commits/" + "a" * 40), {"ok": True})
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/LucasQuiles/WhatSoup/git/commits/" + "a" * 40)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertEqual(timeout, 7)
        self.assertEqual(response.read_sizes, [129])
        self.assertTrue(response.closed)

    def test_safe_api_query_remains_supported(self):
        client, _, opener = self.client()
        client.get_json("commits/" + "a" * 40 + "/pulls?per_page=100")
        self.assertTrue(opener.calls[0][0].full_url.endswith("/pulls?per_page=100"))

    def test_unsafe_paths_are_rejected_before_transport(self):
        for suffix in ["https://attacker.invalid/x", "//attacker.invalid/x", "/user", "../user", "git/../user", "git/%2e%2e/user", "git\\user", "git/refs#fragment", "git/refs\nHeader:x", "git//refs", ""]:
            with self.subTest(suffix=suffix):
                client, _, opener = self.client()
                with self.assertRaises(BoundaryError):
                    client.get_json(suffix)
                self.assertEqual(opener.calls, [])

    def test_bad_credentials_and_limits_are_rejected(self):
        for token in ["", None, "fixture\nheader", "fixture token"]:
            with self.subTest(token=token), self.assertRaises(BoundaryError):
                GitHubClient(token)
        for option, values in [("timeout_seconds", [0, -1, True, 61]), ("max_response_bytes", [0, -1, True, 33_554_433])]:
            for value in values:
                with self.subTest(option=option, value=value), self.assertRaises(BoundaryError):
                    GitHubClient("fixture", **{option: value})

    def test_response_limit_applies_without_content_length(self):
        client, response, _ = self.client(b"x" * 129, max_response_bytes=128)
        with self.assertRaises(BoundaryError):
            client.get_json("pulls/1")
        self.assertEqual(response.read_sizes, [129])
        self.assertTrue(response.closed)

    def test_oversize_declared_response_is_not_read(self):
        client, response, _ = self.client(headers={"Content-Type": "application/json", "Content-Length": "129"}, max_response_bytes=128)
        with self.assertRaises(BoundaryError):
            client.get_json("pulls/1")
        self.assertEqual(response.read_sizes, [])
        self.assertTrue(response.closed)

    def test_malformed_or_ambiguous_json_is_refused(self):
        for raw in [b'{"id":1,"id":2}', b'{"nested":{"id":1,"id":2}}', b'{"value":NaN}', b'"scalar"', b"null", b"\xff", b"not-json"]:
            with self.subTest(raw=raw):
                client, response, _ = self.client(raw)
                with self.assertRaises(BoundaryError):
                    client.get_json("pulls/1")
                self.assertTrue(response.closed)

    def test_http_errors_are_sanitized_and_never_retried(self):
        marker = "private-body-fixture-token"
        for status in [301, 403, 404, 429, 500]:
            with self.subTest(status=status):
                opener = FakeOpener(HTTPError("https://api.github.com", status, marker, {}, io.BytesIO(marker.encode())))
                client = GitHubClient("fixture-token", opener=opener)
                with self.assertRaises(BoundaryError) as caught:
                    client.get_json("pulls/1")
                self.assertNotIn(marker, str(caught.exception))
                self.assertEqual(len(opener.calls), 1)

    def test_transport_failure_is_sanitized(self):
        opener = FakeOpener(URLError("private-detail-fixture-token"))
        client = GitHubClient("fixture-token", opener=opener)
        with self.assertRaises(BoundaryError) as caught:
            client.get_json("pulls/1")
        self.assertNotIn("private-detail", str(caught.exception))

    def test_redirect_response_is_refused_without_followup(self):
        client, response, opener = self.client(status=302, headers={"Content-Type": "text/html", "Location": "https://attacker.invalid"})
        with self.assertRaises(BoundaryError):
            client.get_json("pulls/1")
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(response.read_sizes, [])
        self.assertTrue(response.closed)

    def test_create_check_has_fixed_endpoint_and_no_implicit_retry(self):
        body = {"name": "test-integrity (private)", "head_sha": "a" * 40, "status": "completed", "conclusion": "failure", "output": {"title": "Private test integrity", "summary": "Validation failed."}}
        client, _, opener = self.client(b'{"id":123}', status=201)
        self.assertEqual(client.create_check(body), {"id": 123})
        request, _ = opener.calls[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/LucasQuiles/WhatSoup/check-runs")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), body)
        self.assertEqual(len(opener.calls), 1)

    def test_post_failure_is_not_replayed(self):
        opener = FakeOpener(URLError("response lost after accepted write"))
        client = GitHubClient("fixture-token", opener=opener)
        with self.assertRaises(BoundaryError):
            client.create_check({"name": "test-integrity (private)"})
        self.assertEqual(len(opener.calls), 1)

    def test_deep_outbound_body_is_rejected_before_serialization(self):
        body = {"name": "test-integrity (private)"}
        for _ in range(1500):
            body = {"nested": body}
        client, _, opener = self.client()
        with self.assertRaises(BoundaryError):
            client.create_check(body)
        self.assertEqual(opener.calls, [])

    def test_huge_content_length_is_sanitized_and_response_closed(self):
        client, response, _ = self.client(headers={"Content-Type": "application/json", "Content-Length": "9" * 5000})
        with self.assertRaises(BoundaryError):
            client.get_json("pulls/1")
        self.assertTrue(response.closed)
        self.assertEqual(response.read_sizes, [])

    def test_default_redirect_handler_refuses_and_closes_response(self):
        client = GitHubClient("fixture-token")
        handlers = [handler for handler in client._opener.handlers if isinstance(handler, HTTPRedirectHandler)]
        self.assertEqual(len(handlers), 1)
        response = Response(b"private-response")
        self.addCleanup(response.close)
        request = Request("https://api.github.com/repos/LucasQuiles/WhatSoup/pulls/1")
        with self.assertRaises(BoundaryError):
            handlers[0].redirect_request(request, response, 302, "found", {}, "https://attacker.invalid")
        self.assertTrue(response.closed)

    def test_partial_response_error_is_sanitized_and_closed(self):
        class TruncatedResponse(Response):
            def read(self, size=-1):
                raise IncompleteRead(b"private-partial-body", 100)

        response = TruncatedResponse(b"")
        client = GitHubClient("fixture-token", opener=FakeOpener(response))
        with self.assertRaises(BoundaryError) as caught:
            client.get_json("pulls/1")
        self.assertNotIn("private-partial-body", str(caught.exception))
        self.assertTrue(response.closed)

    def test_batch_blob_request_uses_fixed_graphql_scope_and_exact_blob_bytes(self):
        first = b"first blob\n"
        second = b"second blob\n"
        empty = b""
        objects = ((git_blob_oid(first), len(first)), (git_blob_oid(second), len(second)), (git_blob_oid(empty), len(empty)))
        client, response, opener = self.client(
            graphql_blob_response(((objects[0][0], first), (objects[1][0], second), (objects[2][0], empty)))
        )

        self.assertEqual(
            client.fetch_blob_batch(objects),
            {objects[0][0]: first, objects[1][0]: second, objects[2][0]: empty},
        )

        request, timeout = opener.calls[0]
        body = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.github.com/graphql")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertEqual(timeout, 15)
        self.assertEqual(body["variables"], {"oid0": objects[0][0], "oid1": objects[1][0], "oid2": objects[2][0]})
        self.assertIn('repository(owner:"LucasQuiles",name:"WhatSoup")', body["query"])
        self.assertIn("b0:object(oid:$oid0)", body["query"])
        self.assertIn("b1:object(oid:$oid1)", body["query"])
        self.assertIn("b2:object(oid:$oid2)", body["query"])
        self.assertIn("__typename oid", body["query"])
        self.assertIn("... on Blob{byteSize isBinary isTruncated text}", body["query"])
        self.assertNotIn("mutation", body["query"])
        self.assertLessEqual(len(body["query"].encode()), 65_536)
        expected_limit = min(16_777_216, 6 * sum(size for _, size in objects) + 131_072)
        self.assertEqual(response.read_sizes, [expected_limit + 1])
        self.assertTrue(response.closed)

    def test_batch_rejects_malformed_or_overbudget_inputs_before_transport(self):
        valid_oid = "a" * 40
        cases = {
            "empty": (),
            "not-tuple": [(valid_oid, 1)],
            "duplicate": ((valid_oid, 1), (valid_oid, 1)),
            "bad-oid": (("not-an-object", 1),),
            "boolean-size": ((valid_oid, True),),
            "negative-size": ((valid_oid, -1),),
            "per-blob-limit": ((valid_oid, 1_000_001),),
            "total-limit": ((valid_oid, 1_000_000), ("b" * 40, 1_000_000), ("c" * 40, 97_153)),
            "too-many": tuple((f"{index:040x}", 1) for index in range(81)),
        }
        for label, objects in cases.items():
            with self.subTest(label=label):
                client, _, opener = self.client()
                with self.assertRaises(BoundaryError):
                    client.fetch_blob_batch(objects)
                self.assertEqual(opener.calls, [])

    def test_batch_refuses_graphql_errors_alias_mismatch_and_untrusted_blob_metadata(self):
        content = b"verified content\n"
        object_id = git_blob_oid(content)
        cases = {}

        cases["graphql-errors"] = graphql_blob_response(((object_id, content),), errors=[{"message": "private GraphQL detail"}])

        missing = json.loads(graphql_blob_response(((object_id, content),)))
        del missing["data"]["repository"]["b0"]
        cases["missing-alias"] = json.dumps(missing).encode()

        extra = json.loads(graphql_blob_response(((object_id, content),)))
        extra["data"]["repository"]["b1"] = extra["data"]["repository"]["b0"]
        cases["extra-alias"] = json.dumps(extra).encode()

        binary = json.loads(graphql_blob_response(((object_id, content),)))
        binary["data"]["repository"]["b0"]["isBinary"] = True
        cases["binary"] = json.dumps(binary).encode()

        truncated = json.loads(graphql_blob_response(((object_id, content),)))
        truncated["data"]["repository"]["b0"]["isTruncated"] = "true"
        cases["malformed-truncation"] = json.dumps(truncated).encode()

        wrong_size = json.loads(graphql_blob_response(((object_id, content),)))
        wrong_size["data"]["repository"]["b0"]["byteSize"] += 1
        cases["wrong-size"] = json.dumps(wrong_size).encode()

        for label, raw in cases.items():
            with self.subTest(label=label):
                client, _, opener = self.client(raw)
                with self.assertRaises(BoundaryError) as caught:
                    client.fetch_blob_batch(((object_id, len(content)),))
                self.assertNotIn("private GraphQL detail", str(caught.exception))
                self.assertEqual(len(opener.calls), 1)

    def truncated_response(self, content):
        object_id = git_blob_oid(content)
        payload = json.loads(graphql_blob_response(((object_id, content),)))
        payload["data"]["repository"]["b0"].update(isTruncated=True, text="partial")
        return object_id, payload

    def rest_blob(self, object_id, content):
        return {"sha": object_id, "size": len(content), "encoding": "base64",
                "content": base64.b64encode(content).decode("ascii")}

    def test_truncated_blob_fetches_complete_immutable_bytes_once(self):
        content = b"large test source\n" * 40_000
        object_id, payload = self.truncated_response(content)
        rest = Response(json.dumps(self.rest_blob(object_id, content)).encode())
        opener = FakeOpener([Response(json.dumps(payload).encode()), rest])
        client = GitHubClient("fixture-token", opener=opener)

        self.assertEqual(client.fetch_blob_batch(((object_id, len(content)),)), {object_id: content})
        self.assertEqual(len(opener.calls), 2)
        request, timeout = opener.calls[1]
        self.assertEqual(request.full_url, "https://api.github.com/repos/LucasQuiles/WhatSoup/git/blobs/" + object_id)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertEqual(timeout, 15)
        self.assertEqual(rest.read_sizes, [2 * len(content) + 131_072 + 1])
        self.assertTrue(rest.closed)

    def test_truncated_blob_without_complete_fetch_is_refused(self):
        content = b"complete source\n"
        object_id, payload = self.truncated_response(content)
        with self.assertRaises(BoundaryError):
            _verify_blob_batch_response(payload, ((object_id, len(content)),))

    def test_truncated_blob_metadata_is_verified_before_rest_fetch(self):
        content = b"complete source\n"
        for field, value in [("oid", "a" * 40), ("byteSize", 1), ("isBinary", True),
                             ("__typename", "Tree"), ("text", None), ("isTruncated", 1)]:
            with self.subTest(field=field):
                object_id, payload = self.truncated_response(content)
                payload["data"]["repository"]["b0"][field] = value
                client, _, opener = self.client(json.dumps(payload).encode())
                with self.assertRaises(BoundaryError):
                    client.fetch_blob_batch(((object_id, len(content)),))
                self.assertEqual(len(opener.calls), 1)

    def test_truncated_blob_rest_failure_or_corruption_never_returns_partial_text(self):
        content = b"complete source\n"
        object_id, payload = self.truncated_response(content)
        corruptions = [("sha", "a" * 40), ("size", 1), ("encoding", "utf-8"),
                       ("content", base64.b64encode(b"x" * len(content)).decode("ascii")),
                       ("content", "!")]
        for field, value in corruptions:
            with self.subTest(field=field, value=value):
                raw = self.rest_blob(object_id, content)
                raw[field] = value
                opener = FakeOpener([Response(json.dumps(payload).encode()), Response(json.dumps(raw).encode())])
                with self.assertRaises(BoundaryError):
                    GitHubClient("fixture-token", opener=opener).fetch_blob_batch(((object_id, len(content)),))
                self.assertEqual(len(opener.calls), 2)
        opener = FakeOpener([Response(json.dumps(payload).encode()), URLError("private-response-lost")])
        with self.assertRaises(BoundaryError) as caught:
            GitHubClient("fixture-token", opener=opener).fetch_blob_batch(((object_id, len(content)),))
        self.assertNotIn("private-response-lost", str(caught.exception))
        self.assertEqual(len(opener.calls), 2)

    def test_batch_refuses_mismatched_content_invalid_text_and_wrong_repository_without_leaking_content(self):
        content = b"verified content\n"
        object_id = git_blob_oid(content)
        cases = {}

        wrong_content = json.loads(graphql_blob_response(((object_id, content),)))
        wrong_content["data"]["repository"]["b0"]["text"] = "x" * len(content)
        cases["content"] = json.dumps(wrong_content).encode()

        invalid_text = json.loads(graphql_blob_response(((object_id, content),)))
        invalid_text["data"]["repository"]["b0"]["text"] = "\ud800"
        cases["decode"] = json.dumps(invalid_text).encode()

        cases["wrong-repository"] = graphql_blob_response(((object_id, content),), repository="LucasQuiles/other")

        for label, raw in cases.items():
            with self.subTest(label=label):
                client, _, opener = self.client(raw)
                with self.assertRaises(BoundaryError) as caught:
                    client.fetch_blob_batch(((object_id, len(content)),))
                self.assertNotIn("private mismatched blob", str(caught.exception))
                self.assertEqual(len(opener.calls), 1)

    def test_full_batch_count_uses_one_bounded_request(self):
        contents = [f"test {index}\n".encode() for index in range(80)]
        objects = tuple((git_blob_oid(content), len(content)) for content in contents)
        raw = graphql_blob_response(tuple((oid, content) for (oid, _), content in zip(objects, contents)))
        client, _, opener = self.client(raw)
        result = client.fetch_blob_batch(objects)
        self.assertEqual(result, {oid: content for (oid, _), content in zip(objects, contents)})
        self.assertEqual(len(opener.calls), 1)

    def test_batch_rate_limit_is_sanitized_and_never_retried(self):
        content = b"verified content\n"
        object_id = git_blob_oid(content)
        marker = "private-rate-limit-detail"
        opener = FakeOpener(HTTPError("https://api.github.com/graphql", 429, marker, {}, io.BytesIO(marker.encode())))
        client = GitHubClient("fixture-token", opener=opener)
        with self.assertRaises(BoundaryError) as caught:
            client.fetch_blob_batch(((object_id, len(content)),))
        self.assertNotIn(marker, str(caught.exception))
        self.assertEqual(len(opener.calls), 1)


if __name__ == "__main__":
    unittest.main()
