"""The local fleet API's line list (``GET /api/lines``), shared by its two readers.

``bot-errors-health-check.py`` reads it for the daily inventory line; the
dispatcher reads it to recheck an old logged-out / bond-lost incident against
the line's live state before re-announcing it (relay 16 C2). Both use the same
endpoint, token file and profile keys, so the endpoint, token and response
parsing live here once. No new credential: the token is the fleet token the
health check already reads.

What a line row offers the recheck (``src/fleet/routes/lines.ts``):
``linkedStatus`` (linked | unlinked | unknown) and ``linkedStatusConfidence``
(confirmed | inferred). The row's ``health`` snapshot can carry an
outbound-send time (``outbound_sends.latest_successful_send_at``), but this
module does not read it (``lastActive`` is any activity and ``messageStats``
holds counts only). A recheck never retires a line incident on linked +
confirmed alone: the dispatcher also asks for the recovery path's proof (a
send after the incident or a sustained stable connection) from the
incident's own health reading (relay 19 B1), and fails closed without it.
"""
from __future__ import annotations

import base64
import errno
import io
import ipaddress
import json
import math
import os
import socket
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

try:  # imported as ``lib.fleet_lines`` by the deploy scripts
    from lib.fleet_config import (
        HEALTH_PROFILE_JSON_ENV,
        FleetConfigError,
        read_json_object,
        resolve_health_profile,
        tracked_health_profile_path,
    )
except ImportError:  # loaded by file path, without deploy/scripts on sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from lib.fleet_config import (
        HEALTH_PROFILE_JSON_ENV,
        FleetConfigError,
        read_json_object,
        resolve_health_profile,
        tracked_health_profile_path,
    )


FLEET_LINES_MAX_BYTES = 256 * 1024
FLEET_TOKEN_MAX_BYTES = 4096
DEFAULT_FLEET_TOKEN_FILE = Path.home() / ".config/whatsoup/fleet-tokens.json"


def host_profile_name() -> str:
    """Host token used to name per-host profiles.

    Mirrors the install scripts (``hostname -s | tr '[:upper:]' '[:lower:]'``):
    first DNS label of the hostname, lowercased.
    """
    return socket.gethostname().split(".")[0].strip().lower()


def fleet_api_endpoint(raw_url: str) -> str:
    url = raw_url.rstrip("/")
    if url.endswith("/api/lines") or url.endswith("/api/instances"):
        return url
    return f"{url}/api/lines"


def fleet_api_profile_value(profile: dict[str, Any], key: str) -> str | None:
    value = profile.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    fleet_api = profile.get("fleetApi") if isinstance(profile.get("fleetApi"), dict) else {}
    nested = fleet_api.get(key)
    if isinstance(nested, str) and nested.strip():
        return nested.strip()
    return None


def fleet_api_profile_port(profile: dict[str, Any]) -> str | None:
    fleet_api = profile.get("fleetApi") if isinstance(profile.get("fleetApi"), dict) else {}
    for source in (profile, fleet_api):
        for key in ("fleetApiPort", "port"):
            value = source.get(key)
            if isinstance(value, int):
                return str(value)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def fleet_api_default_url(profile: dict[str, Any]) -> str:
    raw_bind = (
        os.environ.get("FLEET_BIND_ADDRESS")
        or fleet_api_profile_value(profile, "fleetBindAddress")
        or fleet_api_profile_value(profile, "bindAddress")
        or "127.0.0.1"
    )
    bind = raw_bind.strip()
    if bind in {"", "0.0.0.0", "::", "[::]"}:
        bind = "127.0.0.1"
    elif ":" in bind and not bind.startswith("["):
        bind = f"[{bind}]"
    port = (
        os.environ.get("BOT_ERRORS_FLEET_API_PORT")
        or fleet_api_profile_port(profile)
        or "9099"
    ).strip()
    return f"http://{bind}:{port}"


def fleet_api_url(profile: dict[str, Any]) -> str:
    """The /api/lines endpoint: env override, then the profile, then the default bind."""
    raw_url = (
        os.environ.get("BOT_ERRORS_FLEET_API_URL")
        or fleet_api_profile_value(profile, "fleetApiUrl")
        or fleet_api_default_url(profile)
    )
    return fleet_api_endpoint(raw_url)


def _is_loopback_host(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def fleet_api_token_target_refused(url: str, profile: dict[str, Any]) -> bool:
    """True unless ``url`` names a supported API path on literal loopback http.

    Relay 22 A2: the URL can come from an environment or profile override, and
    the fleet token goes with the request, so any non-loopback host (or scheme,
    or a URL carrying user info) is refused before a request is built. A
    configured non-loopback bind is not local proof: remote access must use the
    loopback listener through its TLS front door. Named aliases, including
    localhost, are refused because their resolution is not a peer-address proof.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname
        has_user_info = parts.username is not None or parts.password is not None
        parts.port  # noqa: B018 - a bad port raises ValueError here
    except ValueError:
        return True
    if parts.scheme != "http" or not host or has_user_info or parts.query or parts.fragment:
        return True
    if parts.path not in {"/api/lines", "/api/instances"}:
        return True
    return not _is_loopback_host(host)


class _RedirectRefused(HTTPRedirectHandler):
    """Never follow a redirect: the Authorization header would go with it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 - stdlib signature
        return None


def fleet_api_opener() -> Callable[..., Any]:
    """No proxies or redirects; one deadline covers headers and the entire body."""
    return _bounded_fleet_open


class _FleetResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int) -> None:
        super().__init__(body)
        self.status = status


def _bounded_fleet_open(request: Request, *, timeout: float) -> _FleetResponse:
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("fleet request timeout must be finite and positive")
    payload = json.dumps({
        "url": request.full_url,
        "headers": dict(request.header_items()),
        "timeout": timeout,
    }).encode()
    # urllib's timeout is an inactivity timeout. A separate process lets the
    # caller bound a peer that keeps dripping bytes, then kill and reap it.
    # Credentials travel through stdin, never arguments or error messages.
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(Path(__file__).resolve())],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError("fleet transfer deadline exceeded") from None
    if completed.returncode != 0:
        raise OSError("fleet transfer worker failed")
    result = json.loads(completed.stdout)
    if error := result.get("error"):
        if error == "ValueError":
            raise ValueError("fleet request refused")
        if error == "TimeoutError":
            raise TimeoutError("fleet transfer deadline exceeded")
        raise URLError(error)
    body = base64.b64decode(result["body"], validate=True)
    status = result["status"]
    if status >= 300:
        raise HTTPError(request.full_url, status, "fleet HTTP error", {}, io.BytesIO(body))
    return _FleetResponse(body, status)


def _fleet_transfer_worker() -> None:
    try:
        payload = json.loads(sys.stdin.buffer.read(64 * 1024))
        request = Request(payload["url"], method="GET", headers=payload["headers"])
        opener = build_opener(ProxyHandler({}), _RedirectRefused())
        try:
            response = opener.open(request, timeout=payload["timeout"])
        except HTTPError as exc:
            response = exc
        with response:
            status = response.status
            body = response.read(FLEET_LINES_MAX_BYTES + 1)
        if len(body) > FLEET_LINES_MAX_BYTES:
            raise ValueError("fleet response too large")
        result = {"status": status, "body": base64.b64encode(body).decode("ascii")}
    except Exception as exc:  # noqa: BLE001 - never expose request or token bytes
        result = {"error": type(exc).__name__}
    sys.stdout.write(json.dumps(result))


def fleet_token_path(profile: dict[str, Any]) -> str:
    return (
        os.environ.get("BOT_ERRORS_FLEET_TOKEN_FILE")
        or fleet_api_profile_value(profile, "fleetApiTokenFile")
        or str(DEFAULT_FLEET_TOKEN_FILE)
    )


def _short_error(text: str) -> str:
    return text[:160]


def read_fleet_token_text(
    path: Path, *, describe_error: Callable[[str], str] = _short_error
) -> tuple[str | None, str | None]:
    """Read the token file without following a symlink anywhere on its path.

    Returns ``(text, None)`` or ``(None, reason)``. ``describe_error`` renders
    an OS error for the reason (the health check passes its evidence redactor).
    """
    absolute = Path(os.path.abspath(os.fspath(path)))
    if len(absolute.parts) >= 2:
        platform_root = Path(absolute.parts[0]) / absolute.parts[1]
        if platform_root in {Path("/tmp"), Path("/var")} and platform_root.is_symlink():
            absolute = Path(os.path.realpath(platform_root)).joinpath(*absolute.parts[2:])
    parts = absolute.parts
    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if no_follow is None or directory_flag is None or len(parts) < 2:
        return None, "token_secure_open_unavailable"

    common_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(parts[0], common_flags | directory_flag)
    try:
        for depth, part in enumerate(parts[1:-1], start=1):
            try:
                next_fd = os.open(part, common_flags | directory_flag | no_follow, dir_fd=parent_fd)
            except OSError as exc:
                error_name = errno.errorcode.get(exc.errno, "UNKNOWN")
                return None, f"token_parent_refused errno={error_name} depth={depth}"
            os.close(parent_fd)
            parent_fd = next_fd

        leaf = parts[-1]
        try:
            file_fd = os.open(
                leaf,
                common_flags | no_follow | getattr(os, "O_NONBLOCK", 0),
                dir_fd=parent_fd,
            )
        except OSError as exc:
            try:
                leaf_stat = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except OSError:
                leaf_stat = None
            if leaf_stat is not None and stat.S_ISLNK(leaf_stat.st_mode):
                return None, "token_symlink_refused"
            return None, f"token_unreadable error={describe_error(str(exc))}"

        try:
            st = os.fstat(file_fd)
            mode = stat.S_IMODE(st.st_mode)
            if not stat.S_ISREG(st.st_mode):
                return None, "token_non_regular_refused"
            if mode & 0o077:
                return None, f"token_mode_too_open mode={mode:o}"
            if not mode & 0o400:
                return None, f"token_owner_read_required mode={mode:o}"
            if st.st_size > FLEET_TOKEN_MAX_BYTES:
                return None, "token_too_large"
            raw = bytearray()
            remaining = FLEET_TOKEN_MAX_BYTES + 1
            while remaining:
                chunk = os.read(file_fd, min(64 * 1024, remaining))
                if not chunk:
                    break
                raw.extend(chunk)
                remaining -= len(chunk)
            if len(raw) > FLEET_TOKEN_MAX_BYTES:
                return None, "token_too_large"
            return bytes(raw).decode("utf-8"), None
        finally:
            if file_fd >= 0:
                os.close(file_fd)
    finally:
        os.close(parent_fd)


def parse_fleet_token(loaded: Any) -> tuple[str | None, int, str | None]:
    """``(active token, accept count, error)`` from the parsed token file."""
    if not isinstance(loaded, dict):
        return None, 0, "token_json_root_not_object"
    active = loaded.get("active")
    accept = loaded.get("accept")
    accept_count = len(accept) if isinstance(accept, list) else 0
    if not isinstance(active, str) or not active.strip():
        return None, accept_count, "active_token_missing"
    return active.strip(), accept_count, None


def fleet_lines_from_data(data: Any) -> list[Any] | None:
    """The line rows of a parsed /api/lines response, or None for an unknown shape."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("instances"), list):
        return data["instances"]
    if isinstance(data, dict) and isinstance(data.get("lines"), list):
        return data["lines"]
    return None


def profile_flag(profile: dict[str, Any], key: str, default: bool) -> bool:
    value = profile.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on"}
    return bool(value)


def load_local_health_profile(repo_root: Path) -> dict[str, Any]:
    """This host's health profile, as the health check resolves it, or {} when there is none."""
    raw = os.environ.get(HEALTH_PROFILE_JSON_ENV)
    try:
        if raw:
            loaded = json.loads(raw)
            return loaded if isinstance(loaded, dict) else {}
        return read_json_object(resolve_health_profile(tracked_health_profile_path(repo_root, host_profile_name())))
    except (FleetConfigError, ValueError, OSError):
        return {}


@dataclass(frozen=True)
class FleetLinesRead:
    """One read of the local line list. ``lines`` is None when it could not be read."""

    lines: dict[str, dict[str, Any]] | None
    error: str | None = None


def read_fleet_lines(
    profile: dict[str, Any],
    *,
    timeout: float,
    opener: Callable[..., Any] | None = None,
) -> FleetLinesRead:
    """GET the local /api/lines with the fleet token; rows keyed by line name.

    Every failure is a reason, never a raise: a recheck that cannot read the
    list must say "could not check", not stop a cycle. The token goes only to
    the local fleet API (relay 22 A2): no proxy, no redirect followed, and no
    request at all to another host.
    """
    if not profile_flag(profile, "expectFleetApi", False):
        return FleetLinesRead(None, "fleet_api_not_expected_on_this_host")
    url = fleet_api_url(profile)
    if fleet_api_token_target_refused(url, profile):
        return FleetLinesRead(None, "fleet_api_host_refused")
    try:
        raw, read_error = read_fleet_token_text(Path(fleet_token_path(profile)).expanduser())
        if read_error is not None:
            return FleetLinesRead(None, read_error.split(" ", 1)[0])
        token, _accept_count, token_error = parse_fleet_token(json.loads(raw or ""))
        if token_error is not None:
            return FleetLinesRead(None, token_error)
        request = Request(url, method="GET", headers={"Authorization": f"Bearer {token}"})
        with (opener or fleet_api_opener())(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200))
            body = response.read(FLEET_LINES_MAX_BYTES).decode("utf-8", errors="replace")
    except HTTPError as exc:
        exc.close()
        if 300 <= exc.code < 400:
            return FleetLinesRead(None, "fleet_api_redirect_refused")
        return FleetLinesRead(None, f"fleet_api_unreadable:{type(exc).__name__}")
    except Exception as exc:  # noqa: BLE001 - any failure is "could not check"
        return FleetLinesRead(None, f"fleet_api_unreadable:{type(exc).__name__}")
    if status < 200 or status >= 300:
        return FleetLinesRead(None, f"fleet_api_status_{status}")
    try:
        rows = fleet_lines_from_data(json.loads(body))
    except ValueError:
        return FleetLinesRead(None, "fleet_api_invalid_json")
    if rows is None:
        return FleetLinesRead(None, "fleet_api_invalid_response")
    lines: dict[str, dict[str, Any]] = {}
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("name"), str) and row["name"].strip():
            lines[row["name"].strip()] = row
    return FleetLinesRead(lines)


LINE_LINKED_CONFIRMED = "linked_confirmed"
LINE_LOGGED_OUT = "logged_out"
LINE_COULD_NOT_CHECK = "could_not_check"


def line_verdict(row: dict[str, Any] | None) -> str:
    """linked + confirmed, unlinked + confirmed, or could-not-check (anything else).

    Inferred confidence is never enough either way: an inferred "linked" can be
    a stale reading, and an inferred "unlinked" can be a missing auth file read.
    """
    if not isinstance(row, dict):
        return LINE_COULD_NOT_CHECK
    status = row.get("linkedStatus")
    confidence = row.get("linkedStatusConfidence")
    if confidence != "confirmed":
        return LINE_COULD_NOT_CHECK
    if status == "linked":
        return LINE_LINKED_CONFIRMED
    if status == "unlinked":
        return LINE_LOGGED_OUT
    return LINE_COULD_NOT_CHECK


if __name__ == "__main__":
    _fleet_transfer_worker()
