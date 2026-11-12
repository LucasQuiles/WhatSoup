import ctypes
import datetime
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import pwd
import stat
import subprocess
import sys
import types

import pytest

spec = importlib.util.spec_from_file_location('protected_plist', Path(__file__).resolve().parents[3]/'scripts/lib/release-activation/protected_plist.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

# Tests cannot create root-owned files, so the required plist owner is the test's own uid.
OWN = {'owner_uid': os.getuid()}


def test_protected_replace_and_exact_rollback(tmp_path):
    path=tmp_path/'p'; path.write_bytes(b'old'); path.chmod(0o640)
    os.chflags(path, stat.UF_IMMUTABLE)
    before=p.metadata(path)
    try:
        p.replace(path,p.digest(b'old'),b'new',before,**OWN)
        assert path.read_bytes()==b'new' and p.metadata(path)==before
        p.replace(path,p.digest(b'new'),b'old',before,**OWN)
        assert path.read_bytes()==b'old' and p.metadata(path)==before
    finally:
        os.chflags(path,0)


def test_foreign_change_is_preserved(tmp_path):
    path=tmp_path/'p'; path.write_bytes(b'foreign')
    with pytest.raises(RuntimeError): p.replace(path,p.digest(b'old'),b'new',p.metadata(path),**OWN)
    assert path.read_bytes()==b'foreign'


@pytest.mark.parametrize('failure',['replace','reprotect'])
def test_failures_restore_bytes_and_protection(tmp_path,monkeypatch,failure):
    path=tmp_path/'p';path.write_bytes(b'old');os.chflags(path,stat.UF_IMMUTABLE)
    before=p.metadata(path)
    real_rename,real_flags=p.rename_in,p.set_flags
    failed=False
    def rename(*args):
        nonlocal failed
        if failure=='replace' and not failed:
            failed=True;raise OSError('injected')
        return real_rename(*args)
    def flags(fd,value):
        nonlocal failed
        if failure=='reprotect' and value and path.read_bytes()==b'new' and not failed:
            failed=True;raise OSError('injected')
        return real_flags(fd,value)
    monkeypatch.setattr(p,'rename_in',rename);monkeypatch.setattr(p,'set_flags',flags)
    try:
        with pytest.raises(OSError):p.replace(path,p.digest(b'old'),b'new',before,**OWN)
        assert path.read_bytes()==b'old' and p.metadata(path)==before
        assert sorted(x.name for x in tmp_path.iterdir())==['p']
    finally:os.chflags(path,0)


# Root replacement is confined to the sudo caller's own ~/Library/LaunchAgents.
# These cases drive main() as root with the write (replace) stubbed, so a target
# that passes the confinement reaches the stub and a refused one never does. The
# helper parses the new contents itself, so nothing else is stubbed.

# The sudo caller is the test's own user, so the folders the test creates are the caller's.
OWN_UID = str(os.getuid())


def _own_launch_agents(root):
    home = root / 'home'
    folder = home / 'Library' / 'LaunchAgents'
    folder.mkdir(parents=True)
    (folder / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    return home, folder


def _drive_main_as_root(monkeypatch, target, home, sudo_uid, *, stub_write=True, original=None, contents=None):
    replaced = []
    looked_up = []
    real_user = pwd.getpwuid(os.getuid())
    monkeypatch.setattr(p.os, 'getuid', lambda: 0)
    # main() requires a root-owned plist; the test's files are owned by the test user.
    monkeypatch.setattr(p, 'PLIST_OWNER_UID', int(OWN_UID))
    if sudo_uid is None:
        monkeypatch.delenv('SUDO_UID', raising=False)
    else:
        monkeypatch.setenv('SUDO_UID', sudo_uid)

    def getpwuid(uid):
        looked_up.append(uid)
        return types.SimpleNamespace(pw_dir=str(home), pw_name=real_user.pw_name, pw_gid=real_user.pw_gid)

    monkeypatch.setattr(pwd, 'getpwuid', getpwuid)
    if contents is None:
        contents = plistlib.dumps({'Label': Path(target).name[:-6]}).decode()
    if stub_write:
        # Record the plist name the write would replace, whichever entry point is used.
        monkeypatch.setattr(p, 'replace', lambda *args, **_: replaced.append(Path(args[0]).name) or {}, raising=False)
        monkeypatch.setattr(p, 'replace_at', lambda *args, **_: replaced.append(args[1]) or {}, raising=False)
    expected = p.digest(original) if original is not None else '0' * 64
    request = {'path': str(target), 'contents': contents, 'expectedSha256': expected, 'metadata': {}}
    monkeypatch.setattr(p.sys, 'stdin', io.StringIO(json.dumps(request)))
    return replaced, looked_up


def test_root_replacement_accepts_an_existing_plist_in_the_callers_launch_agents(tmp_path, monkeypatch):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    replaced, looked_up = _drive_main_as_root(monkeypatch, target, home, OWN_UID)
    p.main()
    assert replaced == [target.name]
    assert looked_up == [int(OWN_UID)]


def test_root_replacement_never_runs_a_program_found_on_path(tmp_path, monkeypatch):
    # sudo can keep the caller's PATH, so a program the helper names without a path
    # would be one the caller chose, run as root. A fake plutil first on PATH records
    # whether it ran; the helper must still reach the write without it.
    root = tmp_path.resolve()
    home, folder = _own_launch_agents(root)
    target = folder / 'com.whatsoup.alpha.plist'
    marker = root / 'fake-plutil-ran'
    fake_bin = root / 'bin'
    fake_bin.mkdir()
    fake = fake_bin / 'plutil'
    fake.write_text('#!/bin/sh\n'
                    f"/usr/bin/touch '{marker}'\n"
                    '/bin/cat >/dev/null\n'
                    """/bin/echo '{"Label": "com.whatsoup.alpha"}'\n""")
    fake.chmod(0o755)
    monkeypatch.setenv('PATH', f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}")
    replaced, _ = _drive_main_as_root(monkeypatch, target, home, OWN_UID)
    p.main()
    assert not marker.exists(), 'the root helper ran a program found by name on PATH'
    assert replaced == [target.name]


def test_root_replacement_accepts_json_shaped_plist_values(tmp_path, monkeypatch):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    contents = plistlib.dumps({
        'Label': 'com.whatsoup.alpha',
        'ProgramArguments': ['/usr/bin/true', 'run'],
        'EnvironmentVariables': {'MODE': 'release'},
        'RunAtLoad': True,
        'ThrottleInterval': 10,
        'Nice': 0.5,
    }).decode()
    replaced, _ = _drive_main_as_root(monkeypatch, target, home, OWN_UID, contents=contents)
    p.main()
    assert replaced == [target.name]


def _plist(value):
    return plistlib.dumps(value).decode()


_WHEN = datetime.datetime(2026, 1, 1)

# The exact header the instance renderer writes (src/fleet/platform.ts).
_HEADER = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n')
_LABEL = '<key>Label</key><string>com.whatsoup.alpha</string>'


def _xml(body):
    return _HEADER + '<plist version="1.0">' + body + '</plist>\n'


# plistlib skips unknown elements and keeps the last of several top-level values;
# native plutil refuses both. The helper validates the structure strictly first.
_UNKNOWN_ELEMENT = _xml('<dict>' + _LABEL + '<bogus/></dict>')
_TWO_TOP_LEVEL_DICTS = _xml('<dict>' + _LABEL + '</dict><dict>' + _LABEL + '</dict>')


# The helper once validated the contents by converting them to JSON with plutil.
# It keeps that contract: an XML property list whose top level is a dictionary of
# JSON-representable values (dictionary, array, string, integer, finite real,
# boolean) whose Label names the target.
@pytest.mark.parametrize('contents', [
    '<plist><dict><key>Label</key>',
    '',
    json.dumps({'Label': 'com.whatsoup.alpha'}),
    _plist(['com.whatsoup.alpha']),
    _plist({}),
    _plist({'Label': 'com.whatsoup.beta'}),
    _plist({'Label': 'com.whatsoup.alpha', 'Blob': b'x'}),
    _plist({'Label': 'com.whatsoup.alpha', 'When': _WHEN}),
    _plist({'Label': 'com.whatsoup.alpha', 'Nested': [{'When': _WHEN}]}),
    _plist({'Label': 'com.whatsoup.alpha', 'Nice': float('nan')}),
    '<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY a "com.whatsoup.alpha">]>'
    '<plist version="1.0"><dict><key>Label</key><string>&a;</string></dict></plist>',
    _UNKNOWN_ELEMENT,
    _TWO_TOP_LEVEL_DICTS,
    _xml('<dict>' + _LABEL + '</dict><string>x</string>'),
    '<?xml version="1.0"?><!DOCTYPE plist SYSTEM "file:///private/tmp/x.dtd"><plist version="1.0"><dict>' + _LABEL + '</dict></plist>',
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"'
    ' [<!ELEMENT plist ANY>]><plist version="1.0"><dict>' + _LABEL + '</dict></plist>',
    _HEADER + '<?evil run?><plist version="1.0"><dict>' + _LABEL + '</dict></plist>',
    _xml('<dict>' + _LABEL + '<?evil run?></dict>'),
    _xml('<dict>' + _LABEL + '<key>Dangling</key></dict>'),
    _xml('<dict>' + _LABEL + 'loose text</dict>'),
    _xml('<dict>' + _LABEL + '<key>A</key><array><key>B</key></array></dict>'),
    _xml('<dict>' + _LABEL + '<key>A</key><string><string>nested</string></string></dict>'),
    _xml('<dict>' + _LABEL + '<key>A</key><plist><dict/></plist></dict>'),
    _xml('<dict>' + _LABEL + '<key>A</key><true>yes</true></dict>'),
    _HEADER + '<plist version="1.0" extra="1"><dict>' + _LABEL + '</dict></plist>',
    _HEADER + '<plist version="1.0"></plist>',
    _HEADER + '<dict>' + _LABEL + '</dict>',
], ids=[
    'malformed-xml',
    'empty',
    'json-text',
    'top-level-array',
    'no-label',
    'label-of-another-plist',
    'data-value',
    'date-value',
    'nested-date-value',
    'non-finite-real',
    'entity-declaration',
    'unknown-element',
    'two-top-level-dicts',
    'two-top-level-values',
    'non-apple-doctype',
    'doctype-internal-subset',
    'processing-instruction-before-root',
    'processing-instruction-in-dict',
    'dict-key-without-value',
    'text-in-dict',
    'key-outside-dict',
    'element-inside-string',
    'nested-plist',
    'text-in-true',
    'unknown-plist-attribute',
    'empty-plist',
    'root-is-not-plist',
])
def test_root_replacement_refuses_contents_without_a_json_form(tmp_path, monkeypatch, contents):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    replaced, _ = _drive_main_as_root(monkeypatch, target, home, OWN_UID, contents=contents)
    with pytest.raises(RuntimeError):
        p.main()
    assert replaced == []


def _system_folder(root):
    home, _ = _own_launch_agents(root)
    return Path('/Library/LaunchAgents/com.whatsoup.alpha.plist'), home, OWN_UID


def _root_home_names_the_system_folder(root):
    return Path('/Library/LaunchAgents/com.whatsoup.alpha.plist'), Path('/'), OWN_UID


def _another_users_home(root):
    home, _ = _own_launch_agents(root)
    other = root / 'other' / 'Library' / 'LaunchAgents'
    other.mkdir(parents=True)
    (other / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    return other / 'com.whatsoup.alpha.plist', home, OWN_UID


def _missing_target(root):
    home, folder = _own_launch_agents(root)
    return folder / 'com.whatsoup.beta.plist', home, OWN_UID


def _not_a_whatsoup_plist_name(root):
    home, folder = _own_launch_agents(root)
    (folder / 'com.whatsoup.alpha.plist.bak').write_bytes(b'old')
    return folder / 'com.whatsoup.alpha.plist.bak', home, OWN_UID


def _symlinked_target(root):
    home, folder = _own_launch_agents(root)
    elsewhere = root / 'elsewhere.plist'
    elsewhere.write_bytes(b'old')
    (folder / 'com.whatsoup.gamma.plist').symlink_to(elsewhere)
    return folder / 'com.whatsoup.gamma.plist', home, OWN_UID


def _hard_linked_target(root):
    # A second name for a file outside the folder: root would act on that file's inode.
    home, folder = _own_launch_agents(root)
    elsewhere = root / 'elsewhere.plist'
    elsewhere.write_bytes(b'old')
    os.link(elsewhere, folder / 'com.whatsoup.gamma.plist')
    return folder / 'com.whatsoup.gamma.plist', home, OWN_UID


def _symlinked_launch_agents_folder(root):
    real = root / 'real-agents'
    real.mkdir()
    (real / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    home = root / 'home'
    (home / 'Library').mkdir(parents=True)
    (home / 'Library' / 'LaunchAgents').symlink_to(real)
    return home / 'Library' / 'LaunchAgents' / 'com.whatsoup.alpha.plist', home, OWN_UID


def _caller(sudo_uid):
    def build(root):
        home, folder = _own_launch_agents(root)
        return folder / 'com.whatsoup.alpha.plist', home, sudo_uid
    return build


@pytest.mark.parametrize('case', [
    _system_folder,
    _root_home_names_the_system_folder,
    _another_users_home,
    _missing_target,
    _not_a_whatsoup_plist_name,
    _symlinked_target,
    _hard_linked_target,
    _symlinked_launch_agents_folder,
    _caller(None),
    _caller('0'),
    _caller('not-a-uid'),
    _caller('٥٠١'),
], ids=[
    'system-launch-agents',
    'root-home-is-the-system-folder',
    'another-users-home',
    'missing-target',
    'not-a-whatsoup-plist-name',
    'symlinked-target',
    'hard-linked-target',
    'symlinked-launch-agents-folder',
    'no-sudo-uid',
    'sudo-uid-root',
    'sudo-uid-not-a-number',
    'sudo-uid-non-ascii-digits',
])
def test_root_replacement_refuses_targets_outside_the_callers_launch_agents(tmp_path, monkeypatch, case):
    target, home, sudo_uid = case(tmp_path.resolve())
    replaced, _ = _drive_main_as_root(monkeypatch, target, home, sudo_uid)
    with pytest.raises(RuntimeError):
        p.main()
    assert replaced == []


def test_root_replacement_writes_nothing_outside_the_folder_when_it_is_swapped_after_validation(tmp_path, monkeypatch):
    # The sudo caller owns ~/Library. After the helper has validated the folder and
    # read the plist, and before it writes, the caller moves LaunchAgents away and
    # puts a symlink to a folder it does not own in its place. Root must not create,
    # replace or re-flag anything there, and the run must fail.
    root = tmp_path.resolve()
    home, folder = _own_launch_agents(root)
    target = folder / 'com.whatsoup.alpha.plist'
    moved = home / 'Library' / 'LaunchAgents.moved'
    victim = root / 'not-the-callers'
    victim.mkdir()
    (victim / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    _drive_main_as_root(monkeypatch, target, home, OWN_UID, stub_write=False, original=b'old')

    real_digest = p.digest
    swapped = []

    def digest(data):
        # The helper digests the plist it read before it writes anything.
        if not swapped:
            folder.rename(moved)
            folder.symlink_to(victim, target_is_directory=True)
            swapped.append(True)
        return real_digest(data)

    monkeypatch.setattr(p, 'digest', digest)
    real_fsync = p.os.fsync
    victim_listings = []

    def fsync(fd):
        # Every write is flushed; record what the other folder holds at that moment.
        victim_listings.append(sorted(os.listdir(victim)))
        return real_fsync(fd)

    monkeypatch.setattr(p.os, 'fsync', fsync)

    with pytest.raises(RuntimeError):
        p.main()

    assert swapped and victim_listings, 'the swap must happen and the helper must reach a write'
    assert all(listing == ['com.whatsoup.alpha.plist'] for listing in victim_listings)
    assert sorted(os.listdir(victim)) == ['com.whatsoup.alpha.plist']
    assert (victim / 'com.whatsoup.alpha.plist').read_bytes() == b'old'
    assert sorted(os.listdir(moved)) == ['com.whatsoup.alpha.plist']
    assert (moved / 'com.whatsoup.alpha.plist').read_bytes() == b'old'


# ---- R45: strict XML, measured against native plutil ----

_PLUTIL = '/usr/bin/plutil'
_needs_plutil = pytest.mark.skipif(sys.platform != 'darwin' or not os.path.exists(_PLUTIL),
                                   reason='plutil -lint parity is measured only on macOS, where native plutil exists')


def _plutil_accepts(tmp_path, contents):
    candidate = tmp_path / 'candidate.plist'
    candidate.write_text(contents)
    return subprocess.run([_PLUTIL, '-lint', str(candidate)], capture_output=True).returncode == 0


@_needs_plutil
@pytest.mark.parametrize('contents', [_UNKNOWN_ELEMENT, _TWO_TOP_LEVEL_DICTS], ids=['unknown-element', 'two-top-level-dicts'])
def test_strict_xml_refuses_what_native_plutil_refuses(tmp_path, contents):
    assert not _plutil_accepts(tmp_path, contents)
    with pytest.raises(RuntimeError):
        p.check_contents(contents.encode(), 'com.whatsoup.alpha')


@_needs_plutil
def test_strict_xml_accepts_the_renderers_plist_as_native_plutil_does(tmp_path):
    contents = _xml('<dict>' + _LABEL + '<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>'
                    '<key>RunAtLoad</key><true/><key>Nice</key><real>0.5</real><key>Throttle</key><integer>10</integer>'
                    '<key>Env</key><dict><key>MODE</key><string><![CDATA[release]]></string></dict></dict>')
    assert _plutil_accepts(tmp_path, contents)
    p.check_contents(contents.encode(), 'com.whatsoup.alpha')


# ---- R45: what the helper requires of the target, checked before it reads a byte ----

def _record_reads(monkeypatch):
    reads = []
    real_read = p.read_all
    monkeypatch.setattr(p, 'read_all', lambda fd: reads.append(fd) or real_read(fd))
    return reads


@pytest.mark.parametrize('mode', [0o744, 0o4644], ids=['executable', 'setuid'])
def test_refuses_plist_modes_beyond_0644_before_reading(tmp_path, monkeypatch, mode):
    # The run's own temporary copies the target's mode; a setuid or executable root-owned copy must never exist.
    path = tmp_path / 'p'; path.write_bytes(b'old'); path.chmod(mode)
    reads = _record_reads(monkeypatch)
    with pytest.raises(RuntimeError):
        p.replace(path, p.digest(b'old'), b'new', p.metadata(path), **OWN)
    assert reads == [] and path.read_bytes() == b'old'
    assert sorted(x.name for x in tmp_path.iterdir()) == ['p']


def test_refuses_a_plist_not_owned_by_the_required_owner_before_reading(tmp_path, monkeypatch):
    path = tmp_path / 'p'; path.write_bytes(b'old')
    reads = _record_reads(monkeypatch)
    with pytest.raises(RuntimeError):
        p.replace(path, p.digest(b'old'), b'new', p.metadata(path), owner_uid=os.getuid() + 1)
    assert reads == [] and path.read_bytes() == b'old'


def test_refuses_a_plist_the_caller_cannot_read_before_reading(tmp_path, monkeypatch):
    # Root can read any file; the helper must not read one its caller could not, or it leaks a digest match.
    path = tmp_path / 'p'; path.write_bytes(b'old'); path.chmod(0o640)
    reads = _record_reads(monkeypatch)
    stranger = (os.getuid() + 1, frozenset())
    with pytest.raises(RuntimeError):
        p.replace(path, p.digest(b'old'), b'new', p.metadata(path), owner_uid=os.getuid(), reader=stranger)
    assert reads == [] and path.read_bytes() == b'old'
    # Positive control: a caller in the file's group can read it.
    p.replace(path, p.digest(b'old'), b'new', p.metadata(path), owner_uid=os.getuid(),
              reader=(os.getuid() + 1, frozenset({os.stat(path).st_gid})))
    assert path.read_bytes() == b'new'


@pytest.mark.skipif(not hasattr(os, 'chflags'), reason='file flags exist only on BSD and macOS')
def test_the_names_of_an_immutable_inode_are_frozen(tmp_path):
    # The race proof rests on this kernel behaviour: while UF_IMMUTABLE is set, even the
    # file's owner cannot add, remove, move or swap a name of it. A non-root caller cannot
    # clear the flag of a root-owned plist, so the inode the helper opened keeps its one name.
    target = tmp_path / 'target'; target.write_bytes(b'x')
    other = tmp_path / 'other'; other.write_bytes(b'y')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]

    def swap():
        if libc.renamex_np(os.fsencode(other), os.fsencode(target), 0x2) != 0:  # RENAME_SWAP
            raise OSError(ctypes.get_errno(), 'renamex_np')

    os.chflags(target, stat.UF_IMMUTABLE)
    try:
        for change in (lambda: os.unlink(target),
                       lambda: os.rename(target, tmp_path / 'moved'),
                       lambda: os.rename(other, target),
                       lambda: os.link(target, tmp_path / 'link'),
                       swap):
            with pytest.raises(PermissionError):
                change()
        assert os.stat(target).st_nlink == 1
        assert sorted(x.name for x in tmp_path.iterdir()) == ['other', 'target']
    finally:
        os.chflags(target, 0)


def test_root_replacement_refuses_while_another_run_holds_the_lock(tmp_path, monkeypatch):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    replaced, _ = _drive_main_as_root(monkeypatch, target, home, OWN_UID)
    held = os.open(p.__file__, os.O_RDONLY)
    try:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(RuntimeError):
            p.main()
    finally:
        os.close(held)
    assert replaced == []


# ---- R45: exception-safe rollback (Codex Important 3) ----

def _protected_plist(tmp_path):
    path = tmp_path / 'p'; path.write_bytes(b'old'); os.chflags(path, stat.UF_IMMUTABLE)
    return path, p.metadata(path)


def _fail_after_the_replacement(monkeypatch):
    """The replacement lands and is re-protected, then the folder check fails, so the run must restore."""
    real_check = p.assert_same_folder
    calls = []

    def check(folder_fd, reopen_folder):
        calls.append(True)
        if len(calls) == 2:
            raise RuntimeError('injected folder change')
        return real_check(folder_fd, reopen_folder)

    monkeypatch.setattr(p, 'assert_same_folder', check)


def _fail_nth(monkeypatch, name, n, when=lambda *args: True):
    real = getattr(p, name)
    seen = []

    def wrapped(*args):
        if when(*args):
            seen.append(True)
            if len(seen) == n:
                raise OSError('injected ' + name + ' failure')
        return real(*args)

    monkeypatch.setattr(p, name, wrapped)


def _flags(path):
    return os.stat(path).st_flags


def test_restore_allocation_failure_leaves_the_plist_protected_and_reports_incomplete(tmp_path, monkeypatch):
    path, before = _protected_plist(tmp_path)
    _fail_after_the_replacement(monkeypatch)
    _fail_nth(monkeypatch, 'create_temporary', 2)  # the first is the replacement, the second the restore copy
    try:
        with pytest.raises(p.RecoveryIncomplete):
            p.replace(path, p.digest(b'old'), b'new', before, **OWN)
        assert path.read_bytes() == b'new'
        assert _flags(path) == stat.UF_IMMUTABLE, 'the restore cleared protection before it could allocate'
        assert sorted(x.name for x in tmp_path.iterdir()) == ['p']
    finally:
        os.chflags(path, 0)


def test_restore_rename_failure_re_protects_and_reports_incomplete(tmp_path, monkeypatch):
    path, before = _protected_plist(tmp_path)
    _fail_after_the_replacement(monkeypatch)
    _fail_nth(monkeypatch, 'rename_in', 2)  # the first is the replacement, the second the restore
    try:
        with pytest.raises(p.RecoveryIncomplete):
            p.replace(path, p.digest(b'old'), b'new', before, **OWN)
        assert path.read_bytes() == b'new'
        assert _flags(path) == stat.UF_IMMUTABLE
        assert sorted(x.name for x in tmp_path.iterdir()) == ['p']
    finally:
        os.chflags(path, 0)


def test_restore_re_protection_failure_reports_incomplete(tmp_path, monkeypatch):
    path, before = _protected_plist(tmp_path)
    _fail_after_the_replacement(monkeypatch)
    # Non-zero flag sets: the replacement's protection, then the restored file's protection.
    _fail_nth(monkeypatch, 'set_flags', 2, when=lambda fd, value: value != 0)
    try:
        with pytest.raises(p.RecoveryIncomplete):
            p.replace(path, p.digest(b'old'), b'new', before, **OWN)
        assert path.read_bytes() == b'old'
        assert sorted(x.name for x in tmp_path.iterdir()) == ['p']
    finally:
        os.chflags(path, 0)


def test_forward_re_protection_failure_after_a_failed_rename_reports_incomplete(tmp_path, monkeypatch):
    path, before = _protected_plist(tmp_path)
    _fail_nth(monkeypatch, 'rename_in', 1)
    _fail_nth(monkeypatch, 'set_flags', 1, when=lambda fd, value: value != 0)
    try:
        with pytest.raises(p.RecoveryIncomplete):
            p.replace(path, p.digest(b'old'), b'new', before, **OWN)
        assert path.read_bytes() == b'old'
        assert sorted(x.name for x in tmp_path.iterdir()) == ['p']
    finally:
        os.chflags(path, 0)


def test_a_name_swapped_before_re_protection_is_reported_and_left_alone(tmp_path, monkeypatch):
    # The window that cannot be closed: after the rename, before the new file is immutable,
    # the folder owner replaces the name. Root must not touch the planted file, and the run
    # must report that protection is incomplete.
    path, before = _protected_plist(tmp_path)
    planted = tmp_path / 'planted'
    real_flags = p.set_flags
    swapped = []

    def flags(fd, value):
        if value and not swapped and path.read_bytes() == b'new':
            os.rename(path, tmp_path / 'ours-moved')
            planted.write_bytes(b'planted')
            os.rename(planted, path)
            swapped.append(True)
        return real_flags(fd, value)

    monkeypatch.setattr(p, 'set_flags', flags)
    try:
        with pytest.raises(p.RecoveryIncomplete):
            p.replace(path, p.digest(b'old'), b'new', before, **OWN)
        assert swapped
        assert path.read_bytes() == b'planted' and _flags(path) == 0
    finally:
        for name in os.listdir(tmp_path):
            os.chflags(tmp_path / name, 0)


def test_run_exits_3_for_incomplete_recovery_and_2_for_other_failures(monkeypatch, capsys):
    def incomplete():
        raise p.RecoveryIncomplete('injected')

    monkeypatch.setattr(p, 'main', incomplete)
    assert p.run() == 3
    assert json.loads(capsys.readouterr().err) == {'error_type': 'RecoveryIncomplete'}

    def refused():
        raise RuntimeError('injected')

    monkeypatch.setattr(p, 'main', refused)
    assert p.run() == 2
    assert json.loads(capsys.readouterr().err) == {'error_type': 'RuntimeError'}
    monkeypatch.setattr(p, 'main', lambda: None)
    assert p.run() == 0
