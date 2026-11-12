"""The owner-run install step for the root plist helper, driven through its filesystem seams (no root).

Production installs under "/" with owner root:wheel; these tests install under a
temporary anchor with the test's own uid and gid, which the test can chown to.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd

import pytest

ACTIVATION = Path(__file__).resolve().parents[3] / 'scripts/lib/release-activation'
spec = importlib.util.spec_from_file_location('install_root_helper', ACTIVATION / 'install_root_helper.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

OWNER = (os.getuid(), os.getgid())
STRANGER = os.getuid() + 1  # a uid that owns nothing here
HELPER = (ACTIVATION / 'protected_plist.py').read_bytes()


def _pin():
    return m.read_pin()


def _anchor(tmp_path):
    anchor = tmp_path.resolve() / 'root'
    (anchor / 'Library').mkdir(parents=True)
    for folder in (anchor, anchor / 'Library'):
        folder.chmod(0o755)
    return anchor


def _installed(anchor):
    return anchor / Path(_pin()['path']).relative_to('/')


def test_the_pin_is_the_helpers_digest_and_a_fixed_root_path():
    pin = _pin()
    assert set(pin) == {'path', 'sha256'}
    assert pin['sha256'] == hashlib.sha256(HELPER).hexdigest(), 'repin root-helper.json in the same commit as the helper'
    assert pin['path'].startswith('/Library/PrivilegedHelperTools/')


def test_installs_the_pinned_bytes_root_owned_and_read_only(tmp_path):
    anchor = _anchor(tmp_path)
    assert m.install(HELPER, _pin(), anchor=anchor, owner=OWNER) == {'changed': True}
    installed = _installed(anchor)
    info = os.lstat(installed)
    assert installed.read_bytes() == HELPER
    assert (info.st_uid, info.st_gid, info.st_mode & 0o7777, info.st_nlink) == (*OWNER, 0o444, 1)
    folder = os.lstat(installed.parent)
    assert (folder.st_uid, folder.st_mode & 0o7777) == (OWNER[0], 0o755)
    assert sorted(os.listdir(installed.parent)) == [installed.name]


def test_an_existing_correct_install_is_left_alone(tmp_path):
    anchor = _anchor(tmp_path)
    m.install(HELPER, _pin(), anchor=anchor, owner=OWNER)
    inode = os.lstat(_installed(anchor)).st_ino
    assert m.install(HELPER, _pin(), anchor=anchor, owner=OWNER) == {'changed': False}
    assert os.lstat(_installed(anchor)).st_ino == inode


def test_an_outdated_install_is_replaced(tmp_path):
    anchor = _anchor(tmp_path)
    installed = _installed(anchor)
    installed.parent.mkdir(mode=0o755)
    installed.write_bytes(b'# an older helper\n')
    assert m.install(HELPER, _pin(), anchor=anchor, owner=OWNER) == {'changed': True}
    assert installed.read_bytes() == HELPER
    assert os.lstat(installed).st_mode & 0o7777 == 0o444


def test_a_digest_mismatch_is_refused_before_anything_is_written(tmp_path):
    anchor = _anchor(tmp_path)
    with pytest.raises(m.InstallRefused):
        m.install(HELPER + b'# tampered\n', _pin(), anchor=anchor, owner=OWNER)
    assert not _installed(anchor).parent.exists()


def test_a_temporary_name_collision_fails_cleanly(tmp_path, monkeypatch):
    anchor = _anchor(tmp_path)
    folder = _installed(anchor).parent
    folder.mkdir(mode=0o755)
    monkeypatch.setattr(m.secrets, 'token_hex', lambda _n: 'fixed')
    squatter = folder / ('.' + _installed(anchor).name + '.install-fixed')
    squatter.write_bytes(b'not ours')
    with pytest.raises(m.InstallRefused):
        m.install(HELPER, _pin(), anchor=anchor, owner=OWNER)
    assert squatter.read_bytes() == b'not ours'
    assert sorted(os.listdir(folder)) == [squatter.name]


@pytest.mark.parametrize('break_chain', ['group-writable', 'other-writable', 'symlink', 'wrong-owner'])
def test_an_untrusted_ancestor_is_refused(tmp_path, break_chain):
    anchor = _anchor(tmp_path)
    owner = OWNER
    if break_chain == 'group-writable':
        (anchor / 'Library').chmod(0o775)
    elif break_chain == 'other-writable':
        (anchor / 'Library').chmod(0o757)
    elif break_chain == 'symlink':
        (anchor / 'Library').rename(anchor / 'real-library')
        (anchor / 'Library').symlink_to(anchor / 'real-library', target_is_directory=True)
    else:
        owner = (STRANGER, OWNER[1])
    with pytest.raises(m.InstallRefused):
        m.install(HELPER, _pin(), anchor=anchor, owner=owner)
    assert not (anchor / 'Library' / 'PrivilegedHelperTools').exists()
    assert not (anchor / 'real-library' / 'PrivilegedHelperTools').exists()


def _interpreter_tree(tmp_path):
    anchor = tmp_path.resolve() / 'tree'
    python = anchor / 'Developer' / 'usr' / 'bin' / 'python3'
    python.parent.mkdir(parents=True)
    python.write_bytes(b'')
    for path in (anchor, anchor / 'Developer', anchor / 'Developer' / 'usr', python.parent):
        path.chmod(0o755)
    python.chmod(0o755)
    return anchor, python


def test_an_interpreter_chain_the_bot_user_owns_is_refused(tmp_path):
    anchor, python = _interpreter_tree(tmp_path)
    with pytest.raises(m.InstallRefused):
        m.check_interpreter([str(python)], os.getuid(), frozenset(), anchor=anchor)


def test_an_interpreter_chain_writable_through_a_group_of_the_bot_user_is_refused(tmp_path):
    # /Applications is root:admin 0775: a bot user in admin could replace an Xcode there.
    anchor, python = _interpreter_tree(tmp_path)
    (anchor / 'Developer').chmod(0o775)
    with pytest.raises(m.InstallRefused):
        m.check_interpreter([str(python)], STRANGER, frozenset({os.lstat(anchor / 'Developer').st_gid}), anchor=anchor)
    # Positive control: the same chain is accepted for a user outside that group.
    m.check_interpreter([str(python)], STRANGER, frozenset(), anchor=anchor)


@pytest.mark.parametrize('argv', [[], ['--user'], ['--user', ''], ['--user', 'a', 'extra'], ['--name', 'a']])
def test_a_missing_or_malformed_user_argument_is_refused(argv):
    with pytest.raises(m.InstallRefused):
        m.parse_user(argv)


@pytest.mark.parametrize('name', ['whatsoup-no-such-user-b8', 'root'])
def test_an_unknown_or_root_bot_user_is_refused(name):
    with pytest.raises(m.InstallRefused):
        m.bot_identity(name)


def test_main_refuses_unless_it_runs_as_root(monkeypatch):
    monkeypatch.setattr(m.os, 'geteuid', lambda: 501)
    with pytest.raises(m.InstallRefused):
        m.main(['--user', pwd.getpwuid(os.getuid()).pw_name])


def _developer_tree(tmp_path):
    developer = tmp_path.resolve() / 'Xcode.app' / 'Contents' / 'Developer'
    python = developer / 'Library' / 'Frameworks' / 'Python3.framework' / 'bin' / 'python3.9'
    python.parent.mkdir(parents=True)
    python.write_bytes(b'')
    link = tmp_path.resolve() / 'xcode_select_link'
    link.symlink_to(developer, target_is_directory=True)
    return python, link


def test_the_installer_must_run_as_the_isolated_interpreter_sudo_will_run(tmp_path):
    # The chain check inspects the interpreter running the installer, so that must be /usr/bin/python3 -I -B.
    python, link = _developer_tree(tmp_path)
    m.check_invocation(True, True, str(python), select_link=str(link))
    for isolated, no_bytecode in ((False, True), (True, False)):
        with pytest.raises(m.InstallRefused):
            m.check_invocation(isolated, no_bytecode, str(python), select_link=str(link))
    elsewhere = tmp_path.resolve() / 'homebrew' / 'bin' / 'python3.12'
    elsewhere.parent.mkdir(parents=True)
    elsewhere.write_bytes(b'')
    with pytest.raises(m.InstallRefused):
        m.check_invocation(True, True, str(elsewhere), select_link=str(link))


def test_main_reports_the_exact_sudoers_line_for_the_bot_user(monkeypatch, capsys):
    name = pwd.getpwuid(os.getuid()).pw_name
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(m, 'check_invocation', lambda *args: None)
    checked = []
    monkeypatch.setattr(m, 'check_interpreter', lambda paths, uid, groups, **_: checked.append(uid))
    monkeypatch.setattr(m, 'install', lambda data, pin, **_: {'changed': True} if data == HELPER else pytest.fail('wrong bytes'))
    m.main(['--user', name])
    report = json.loads(capsys.readouterr().out)
    pin = _pin()
    assert checked == [os.getuid()]
    assert report == {
        'changed': True,
        'path': pin['path'],
        'sha256': pin['sha256'],
        'sudoers': f"{name} ALL = (root) NOPASSWD: /usr/bin/python3 -I -B {pin['path']}",
    }
