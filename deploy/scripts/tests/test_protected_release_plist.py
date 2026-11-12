import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import stat
import types

import pytest

spec = importlib.util.spec_from_file_location('protected_plist', Path(__file__).resolve().parents[3]/'scripts/lib/release-activation/protected_plist.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def test_protected_replace_and_exact_rollback(tmp_path):
    path=tmp_path/'p'; path.write_bytes(b'old'); path.chmod(0o640)
    os.chflags(path, stat.UF_IMMUTABLE)
    before=p.metadata(path)
    try:
        p.replace(path,p.digest(b'old'),b'new',before)
        assert path.read_bytes()==b'new' and p.metadata(path)==before
        p.replace(path,p.digest(b'new'),b'old',before)
        assert path.read_bytes()==b'old' and p.metadata(path)==before
    finally:
        os.chflags(path,0)


def test_foreign_change_is_preserved(tmp_path):
    path=tmp_path/'p'; path.write_bytes(b'foreign')
    with pytest.raises(RuntimeError): p.replace(path,p.digest(b'old'),b'new',p.metadata(path))
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
        with pytest.raises(OSError):p.replace(path,p.digest(b'old'),b'new',before)
        assert path.read_bytes()==b'old' and p.metadata(path)==before
        assert sorted(x.name for x in tmp_path.iterdir())==['p']
    finally:os.chflags(path,0)


# Root replacement is confined to the sudo caller's own ~/Library/LaunchAgents.
# These cases drive main() as root with the write (replace) and plutil stubbed,
# so a target that passes the confinement reaches the stub and a refused one
# never does.

# The sudo caller is the test's own user, so the folders the test creates are the caller's.
OWN_UID = str(os.getuid())


def _own_launch_agents(root):
    home = root / 'home'
    folder = home / 'Library' / 'LaunchAgents'
    folder.mkdir(parents=True)
    (folder / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    return home, folder


def _drive_main_as_root(monkeypatch, target, home, sudo_uid, *, stub_write=True, original=None):
    replaced = []
    looked_up = []
    monkeypatch.setattr(p.os, 'getuid', lambda: 0)
    if sudo_uid is None:
        monkeypatch.delenv('SUDO_UID', raising=False)
    else:
        monkeypatch.setenv('SUDO_UID', sudo_uid)

    def getpwuid(uid):
        looked_up.append(uid)
        return types.SimpleNamespace(pw_dir=str(home))

    monkeypatch.setattr(pwd, 'getpwuid', getpwuid)
    label = Path(target).name[:-6]

    def run(args, **kwargs):
        if args[0] == 'plutil':
            return types.SimpleNamespace(stdout=json.dumps({'Label': label}).encode())
        return types.SimpleNamespace(stdout=b'')  # any other probe reports nothing

    monkeypatch.setattr(p.subprocess, 'run', run)
    if stub_write:
        # Record the plist name the write would replace, whichever entry point is used.
        monkeypatch.setattr(p, 'replace', lambda *args: replaced.append(Path(args[0]).name) or {}, raising=False)
        monkeypatch.setattr(p, 'replace_at', lambda *args: replaced.append(args[1]) or {}, raising=False)
    expected = p.digest(original) if original is not None else '0' * 64
    request = {'path': str(target), 'contents': '<plist/>', 'expectedSha256': expected, 'metadata': {}}
    monkeypatch.setattr(p.sys, 'stdin', io.StringIO(json.dumps(request)))
    return replaced, looked_up


def test_root_replacement_accepts_an_existing_plist_in_the_callers_launch_agents(tmp_path, monkeypatch):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    replaced, looked_up = _drive_main_as_root(monkeypatch, target, home, OWN_UID)
    p.main()
    assert replaced == [target.name]
    assert looked_up == [int(OWN_UID)]


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
