"""Size-bounded GitHub transport for the trusted private scanner workflow.

The timeout bounds individual socket operations. The trusted workflow must
run its driver under an external total deadline, including slow responses.
"""

from http.client import HTTPException
import hashlib
import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from private_scanner_candidate import BoundaryError


MAX_BLOB_BATCH_OBJECTS = 80
MAX_BLOB_BATCH_BYTES = 2 * 1024 * 1024
MAX_BLOB_BYTES = 1_000_000
_GRAPHQL_QUERY_LIMIT = 64 * 1024
_GRAPHQL_RESPONSE_OVERHEAD = 128 * 1024
_REST_API_ROOT = "https://api.github.com/repos/LucasQuiles/WhatSoup/"
_GRAPHQL_API_URL = "https://api.github.com/graphql"


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        fp.close()
        raise BoundaryError("GitHub response redirected")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BoundaryError("GitHub JSON contains duplicate keys")
        result[key] = value
    return result


def _reject_constant(_value):
    raise BoundaryError("GitHub JSON contains a non-finite number")


def _bounded_json_body(body):
    pending = [(body, 0)]
    nodes = text_bytes = 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if nodes > 256 or depth > 8:
            raise BoundaryError("Check request exceeds structure limit")
        if isinstance(value, str):
            if len(value) > 16_384:
                raise BoundaryError("Check request string exceeds byte limit")
            text_bytes += len(value.encode("utf-8"))
            if text_bytes > 32_768:
                raise BoundaryError("Check request strings exceed byte limit")
        elif isinstance(value, (dict, list)):
            if len(value) > 128:
                raise BoundaryError("Check request exceeds structure limit")
            if isinstance(value, dict):
                if any(not isinstance(key, str) for key in value):
                    raise BoundaryError("Check request keys must be strings")
                pending.extend((key, depth + 1) for key in value)
                pending.extend((item, depth + 1) for item in value.values())
            else:
                pending.extend((item, depth + 1) for item in value)
        elif type(value) is int:
            if value.bit_length() > 63:
                raise BoundaryError("Check request integer exceeds limit")
        elif value is not None and type(value) is not bool:
            raise BoundaryError("Check request value is unsupported")
    data = json.dumps(body, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > 65_536:
        raise BoundaryError("Check request exceeds byte limit")
    return data


class GitHubClient:
    def __init__(self, token, *, opener=None, timeout_seconds=15, max_response_bytes=16_777_216):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_.\-]+", token):
            raise BoundaryError("GitHub credential is missing or malformed")
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 60:
            raise BoundaryError("GitHub request timeout is invalid")
        if type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 33_554_432:
            raise BoundaryError("GitHub response limit is invalid")
        self._token = token
        self._opener = opener if opener is not None else build_opener(_RejectRedirects())
        self._timeout = timeout_seconds
        self._limit = max_response_bytes

    def get_json(self, suffix):
        return self._request("GET", suffix, None, 200)

    def create_check(self, body):
        if not isinstance(body, dict):
            raise BoundaryError("Check request must be an object")
        return self._request("POST", "check-runs", body, 201)

    def fetch_blob_batch(self, objects):
        """Fetch bounded, immutable Git blob text through the fixed GraphQL endpoint.

        The injected opener's socket timeout is not an overall deadline.  The
        trusted driver remains responsible for process-group supervision.
        """
        verified, expected_bytes = _validate_blob_batch(objects)
        variables = {f"oid{index}": object_id for index, (object_id, _) in enumerate(verified)}
        declarations = ",".join(f"$oid{index}:GitObjectID!" for index in range(len(verified)))
        selections = " ".join(
            f"b{index}:object(oid:$oid{index}){{__typename oid ... on Blob{{byteSize isBinary isTruncated text}}}}"
            for index in range(len(verified))
        )
        query = (
            "query(" + declarations + "){repository(owner:\"LucasQuiles\",name:\"WhatSoup\")"
            + "{nameWithOwner " + selections + "}}"
        )
        if len(query.encode("utf-8")) > _GRAPHQL_QUERY_LIMIT:
            raise BoundaryError("GitHub GraphQL query exceeds byte limit")
        response_limit = min(self._limit, 6 * expected_bytes + _GRAPHQL_RESPONSE_OVERHEAD)
        response = self._request_url(
            "POST",
            _GRAPHQL_API_URL,
            {"query": query, "variables": variables},
            200,
            response_limit,
        )
        return _verify_blob_batch_response(response, verified)

    def _request(self, method, suffix, body, expected_status):
        if not isinstance(suffix, str) or not re.fullmatch(r"[A-Za-z0-9_.\-/]+(?:\?[A-Za-z0-9_.=&\-]+)?", suffix):
            raise BoundaryError("GitHub API path is invalid")
        path = suffix.split("?", 1)[0]
        if any(part in {"", ".", ".."} for part in path.split("/")):
            raise BoundaryError("GitHub API path escapes repository scope")
        return self._request_url(
            method,
            _REST_API_ROOT + suffix,
            body,
            expected_status,
            self._limit,
        )

    def _request_url(self, method, url, body, expected_status, response_limit):
        if type(response_limit) is not int or not 1 <= response_limit <= self._limit:
            raise BoundaryError("GitHub response limit is invalid")
        try:
            data = None if body is None else _bounded_json_body(body)
        except (TypeError, ValueError, RecursionError):
            raise BoundaryError("Check request is not JSON") from None
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "WhatSoup-private-test-integrity",
            },
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                if response.status != expected_status:
                    raise BoundaryError("GitHub returned an unexpected status")
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    raise BoundaryError("GitHub response is not JSON")
                length = response.headers.get("Content-Length")
                if length is not None and (len(length) > 10 or not re.fullmatch(r"[0-9]+", length) or int(length) > response_limit):
                    raise BoundaryError("GitHub response exceeds byte limit")
                raw = response.read(response_limit + 1)
        except HTTPError as exc:
            exc.close()
            raise BoundaryError("GitHub HTTP request failed") from None
        except (URLError, OSError, TimeoutError, HTTPException):
            raise BoundaryError("GitHub transport failed") from None
        if len(raw) > response_limit:
            raise BoundaryError("GitHub response exceeds byte limit")
        try:
            result = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        except (UnicodeError, ValueError, RecursionError):
            raise BoundaryError("GitHub JSON response is malformed") from None
        if not isinstance(result, (dict, list)):
            raise BoundaryError("GitHub response is not an object or array")
        return result


def _validate_blob_batch(objects):
    if type(objects) is not tuple or not 1 <= len(objects) <= MAX_BLOB_BATCH_OBJECTS:
        raise BoundaryError("GitHub blob batch is malformed or exceeds object limit")
    seen = set()
    verified = []
    total_bytes = 0
    for item in objects:
        if type(item) is not tuple or len(item) != 2:
            raise BoundaryError("GitHub blob batch item is malformed")
        object_id, size = item
        if not isinstance(object_id, str) or not re.fullmatch(r"[0-9a-f]{40}", object_id):
            raise BoundaryError("GitHub blob object ID is malformed")
        if type(size) is not int or not 0 <= size <= MAX_BLOB_BYTES:
            raise BoundaryError("GitHub blob size is malformed")
        if object_id in seen:
            raise BoundaryError("GitHub blob batch has duplicate object IDs")
        total_bytes += size
        if total_bytes > MAX_BLOB_BATCH_BYTES:
            raise BoundaryError("GitHub blob batch exceeds byte limit")
        seen.add(object_id)
        verified.append((object_id, size))
    return tuple(verified), total_bytes


def _verify_blob_batch_response(response, expected):
    if type(response) is not dict or set(response) != {"data"}:
        raise BoundaryError("GitHub GraphQL response is malformed")
    data = response["data"]
    if type(data) is not dict or set(data) != {"repository"}:
        raise BoundaryError("GitHub GraphQL response is malformed")
    repository = data["repository"]
    aliases = {f"b{index}" for index in range(len(expected))}
    if (
        type(repository) is not dict
        or set(repository) != {"nameWithOwner", *aliases}
        or repository.get("nameWithOwner") != "LucasQuiles/WhatSoup"
    ):
        raise BoundaryError("GitHub GraphQL repository response is malformed")
    blobs = {}
    expected_keys = {"__typename", "oid", "byteSize", "isBinary", "isTruncated", "text"}
    for index, (object_id, size) in enumerate(expected):
        blob = repository[f"b{index}"]
        if (
            type(blob) is not dict
            or set(blob) != expected_keys
            or blob.get("__typename") != "Blob"
            or blob.get("oid") != object_id
            or type(blob.get("byteSize")) is not int
            or blob["byteSize"] != size
            or blob.get("isBinary") is not False
            or blob.get("isTruncated") is not False
            or type(blob.get("text")) is not str
        ):
            raise BoundaryError("GitHub GraphQL blob response is malformed")
        try:
            content = blob["text"].encode("utf-8", "strict")
        except UnicodeError as exc:
            raise BoundaryError("GitHub GraphQL blob text is not UTF-8") from exc
        if len(content) != size or _git_blob_oid(content) != object_id:
            raise BoundaryError("GitHub GraphQL blob bytes do not match their object ID")
        blobs[object_id] = content
    return blobs


def _git_blob_oid(content):
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
