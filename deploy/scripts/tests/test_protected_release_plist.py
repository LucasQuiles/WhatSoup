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
    real_replace,real_flags=p.os.replace,p.os.chflags
    failed=False
    def replace(*args):
        nonlocal failed
        if failure=='replace' and not failed:
            failed=True;raise OSError('injected')
        return real_replace(*args)
    def flags(target,value):
        nonlocal failed
        if failure=='reprotect' and value and path.read_bytes()==b'new' and not failed:
            failed=True;raise OSError('injected')
        return real_flags(target,value)
    monkeypatch.setattr(p.os,'replace',replace);monkeypatch.setattr(p.os,'chflags',flags)
    try:
        with pytest.raises(OSError):p.replace(path,p.digest(b'old'),b'new',before)
        assert path.read_bytes()==b'old' and p.metadata(path)==before
    finally:real_flags(path,0)


# Root replacement is confined to the sudo caller's own ~/Library/LaunchAgents.
# These cases drive main() as root with the write (replace) and plutil stubbed,
# so a target that passes the confinement reaches the stub and a refused one
# never does.

def _own_launch_agents(root):
    home = root / 'home'
    folder = home / 'Library' / 'LaunchAgents'
    folder.mkdir(parents=True)
    (folder / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    return home, folder


def _drive_main_as_root(monkeypatch, target, home, sudo_uid):
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
    monkeypatch.setattr(p.subprocess, 'run',
                        lambda *args, **kwargs: types.SimpleNamespace(stdout=json.dumps({'Label': label}).encode()))
    monkeypatch.setattr(p, 'replace', lambda *args: replaced.append(args) or {'sha256': '', 'metadata': {}})
    request = {'path': str(target), 'contents': '<plist/>', 'expectedSha256': '0' * 64, 'metadata': {}}
    monkeypatch.setattr(p.sys, 'stdin', io.StringIO(json.dumps(request)))
    return replaced, looked_up


def test_root_replacement_accepts_an_existing_plist_in_the_callers_launch_agents(tmp_path, monkeypatch):
    home, folder = _own_launch_agents(tmp_path.resolve())
    target = folder / 'com.whatsoup.alpha.plist'
    replaced, looked_up = _drive_main_as_root(monkeypatch, target, home, '501')
    p.main()
    assert [call[0] for call in replaced] == [target]
    assert looked_up == [501]


def _system_folder(root):
    home, _ = _own_launch_agents(root)
    return Path('/Library/LaunchAgents/com.whatsoup.alpha.plist'), home, '501'


def _root_home_names_the_system_folder(root):
    return Path('/Library/LaunchAgents/com.whatsoup.alpha.plist'), Path('/'), '501'


def _another_users_home(root):
    home, _ = _own_launch_agents(root)
    other = root / 'other' / 'Library' / 'LaunchAgents'
    other.mkdir(parents=True)
    (other / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    return other / 'com.whatsoup.alpha.plist', home, '501'


def _missing_target(root):
    home, folder = _own_launch_agents(root)
    return folder / 'com.whatsoup.beta.plist', home, '501'


def _not_a_whatsoup_plist_name(root):
    home, folder = _own_launch_agents(root)
    (folder / 'com.whatsoup.alpha.plist.bak').write_bytes(b'old')
    return folder / 'com.whatsoup.alpha.plist.bak', home, '501'


def _symlinked_target(root):
    home, folder = _own_launch_agents(root)
    elsewhere = root / 'elsewhere.plist'
    elsewhere.write_bytes(b'old')
    (folder / 'com.whatsoup.gamma.plist').symlink_to(elsewhere)
    return folder / 'com.whatsoup.gamma.plist', home, '501'


def _symlinked_launch_agents_folder(root):
    real = root / 'real-agents'
    real.mkdir()
    (real / 'com.whatsoup.alpha.plist').write_bytes(b'old')
    home = root / 'home'
    (home / 'Library').mkdir(parents=True)
    (home / 'Library' / 'LaunchAgents').symlink_to(real)
    return home / 'Library' / 'LaunchAgents' / 'com.whatsoup.alpha.plist', home, '501'


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
