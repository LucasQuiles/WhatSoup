"""The owner-run install step for the root plist helper, driven through its filesystem seams (no root).

Production installs under "/" with owner root:wheel; these tests install under a
temporary anchor with the test's own uid and gid, which the test can chown to.
"""
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import subprocess

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


# Four distinct named ways to break the ancestor chain, each a regression of its own; the
# body dispatches on the name, so the cases are scenarios, not samples of one input space.
@pytest.mark.parametrize('break_chain', [
    pytest.param('group-writable', id='group-writable'),
    pytest.param('other-writable', id='other-writable'),
    pytest.param('symlink', id='symlink'),
    pytest.param('wrong-owner', id='wrong-owner'),
])
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


def _folders(*paths, mode=0o755):
    for path in paths:
        path.chmod(mode)


def _alias_tree(tmp_path, alias_mode):
    """Codex C1: the select link reaches a trusted developer folder through an alias in a home the bot may write."""
    anchor = tmp_path.resolve() / 'tree'
    developer = anchor / 'Applications' / 'Xcode.app' / 'Contents' / 'Developer'
    python = developer / 'usr' / 'bin' / 'python3'
    python.parent.mkdir(parents=True)
    python.write_bytes(b'')
    home = anchor / 'Users' / 'bot'
    home.mkdir(parents=True)
    (home / 'current').symlink_to(developer, target_is_directory=True)
    select = anchor / 'db' / 'xcode_select_link'
    select.parent.mkdir()
    select.symlink_to(home / 'current', target_is_directory=True)
    _folders(anchor, *[developer.parents[n] for n in range(3)], developer, python.parent.parent, python.parent, python,
             home.parent, select.parent)
    home.chmod(alias_mode)
    return anchor, select, home


def test_a_select_link_through_a_bot_writable_alias_is_refused(tmp_path):
    anchor, select, home = _alias_tree(tmp_path, 0o757)
    lexical = str(select / 'usr' / 'bin' / 'python3')
    # Resolution discards the alias: every folder of the real path is trusted.
    m.check_interpreter([os.path.realpath(lexical)], STRANGER, frozenset(), anchor=anchor)
    # Walking the original components and each symlink hop reaches the bot's folder.
    with pytest.raises(m.InstallRefused, match=str(home)):
        m.check_interpreter([lexical], STRANGER, frozenset(), anchor=anchor)


def test_a_select_link_through_a_trusted_alias_is_accepted(tmp_path):
    anchor, select, home = _alias_tree(tmp_path, 0o755)
    lexical = str(select / 'usr' / 'bin' / 'python3')
    assert m.check_interpreter([lexical], STRANGER, frozenset(), anchor=anchor) is None
    # The walk passed through the alias and its folder, so the acceptance covered them.
    walked = [entry for entry, _ in m.path_chain(lexical)]
    assert home in walked and home / 'current' in walked


def test_a_bot_writable_folder_reached_by_a_relative_hop_is_refused(tmp_path):
    # Opus M-1 layout: Developer/usr/bin/python3 -> ../../Library/Frameworks/.../bin/python3.9.
    # ".." leaves the folder actually reached, so the hop lands in the framework's bin folder.
    anchor, python = _interpreter_tree(tmp_path)
    framework_bin = anchor / 'Developer' / 'Library' / 'Frameworks' / 'Python3.framework' / 'bin'
    framework_bin.mkdir(parents=True)
    (framework_bin / 'python3.9').write_bytes(b'')
    _folders(*[framework_bin.parents[n] for n in range(3)], framework_bin)
    python.unlink()
    python.symlink_to('../../Library/Frameworks/Python3.framework/bin/python3.9')
    m.check_interpreter([str(python)], STRANGER, frozenset(), anchor=anchor)
    framework_bin.chmod(0o757)
    with pytest.raises(m.InstallRefused, match=str(framework_bin)):
        m.check_interpreter([str(python)], STRANGER, frozenset(), anchor=anchor)


def test_a_missing_entry_in_a_bot_writable_folder_is_refused(tmp_path):
    # python39.zip need not exist, but whoever can write its folder can create it.
    anchor = tmp_path.resolve() / 'tree'
    lib = anchor / 'lib'
    lib.mkdir(parents=True)
    _folders(anchor, lib)
    m.check_interpreter([str(lib / 'python39.zip')], STRANGER, frozenset(), anchor=anchor)
    lib.chmod(0o757)
    with pytest.raises(m.InstallRefused, match=str(lib)):
        m.check_interpreter([str(lib / 'python39.zip')], STRANGER, frozenset(), anchor=anchor)


def test_a_symlink_loop_is_refused(tmp_path):
    anchor = tmp_path.resolve() / 'tree'
    anchor.mkdir()
    (anchor / 'a').symlink_to(anchor / 'b')
    (anchor / 'b').symlink_to(anchor / 'a')
    with pytest.raises(m.InstallRefused, match='too many symlinks'):
        m.check_interpreter([str(anchor / 'a' / 'python3')], STRANGER, frozenset(), anchor=anchor)


def test_the_interpreter_paths_are_the_original_unresolved_paths(tmp_path):
    _, select, _ = _alias_tree(tmp_path, 0o755)
    paths = m.interpreter_paths(executable=str(select / 'usr' / 'bin' / 'python3'),
                                path_entries=['', str(select / 'Library' / 'python39.zip')], select_link=str(select))
    assert paths == ['/usr/bin/python3', str(select / 'usr' / 'bin' / 'python3'), str(select / 'usr' / 'bin' / 'python3'),
                     str(select / 'Library' / 'python39.zip')]


# Each case breaks one part of the only accepted shape, `--user <non-empty name>`.
@pytest.mark.parametrize('argv', [
    pytest.param([], id='no-args'),
    pytest.param(['--user'], id='flag-without-value'),
    pytest.param(['--user', ''], id='empty-name'),
    pytest.param(['--user', 'a', 'extra'], id='extra-arg'),
    pytest.param(['--name', 'a'], id='wrong-flag'),
])
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
    # The chain check inspects the interpreter running the installer and its import path,
    # so that must be /usr/bin/python3 -I -S -B (Opus M-2: -S keeps site-packages off the path).
    python, link = _developer_tree(tmp_path)
    m.check_invocation(True, True, True, str(python), select_link=str(link))
    for isolated, no_site, no_bytecode in ((False, True, True), (True, False, True), (True, True, False)):
        with pytest.raises(m.InstallRefused, match='-I -S -B'):
            m.check_invocation(isolated, no_site, no_bytecode, str(python), select_link=str(link))
    elsewhere = tmp_path.resolve() / 'homebrew' / 'bin' / 'python3.12'
    elsewhere.parent.mkdir(parents=True)
    elsewhere.write_bytes(b'')
    with pytest.raises(m.InstallRefused):
        m.check_invocation(True, True, True, str(elsewhere), select_link=str(link))


def _clone(tmp_path):
    anchor = tmp_path.resolve() / 'tree'
    activation = anchor / 'clone' / 'scripts' / 'lib' / 'release-activation'
    activation.mkdir(parents=True)
    files = [activation / name for name in ('install_root_helper.py', 'root-helper.json', 'protected_plist.py')]
    for path in files:
        path.write_bytes(b'')
    _folders(anchor, *[activation.parents[n] for n in range(3)], activation)
    return anchor, [str(path) for path in files]


def test_a_clone_the_bot_user_can_write_is_refused(tmp_path):
    # Opus M-3: the bot user could change the script, the pin or the helper before root reads them,
    # or rename a writable ancestor and put another clone in its place.
    anchor, files = _clone(tmp_path)
    m.check_clone(files, STRANGER, frozenset(), anchor=anchor)
    (anchor / 'clone').chmod(0o757)
    with pytest.raises(m.InstallRefused, match='clone'):
        m.check_clone(files, STRANGER, frozenset(), anchor=anchor)


def _acl(path, entry):
    """Add one ACL entry with the native tool; the test user owns `path`, so this needs no privilege."""
    subprocess.run(['/bin/chmod', '+a', entry, str(path)], check=True)


def test_a_clone_writable_through_an_acl_is_refused(tmp_path):
    # Codex (Opus M-3 residual): owner and mode bits alone accepted a clone the bot user could
    # write through an ACL allow entry. The xattr list does not show ACLs, so libc reads them.
    anchor, files = _clone(tmp_path)
    m.check_clone(files, STRANGER, frozenset(), anchor=anchor)
    _acl(files[2], 'user:nobody allow write')
    with pytest.raises(m.InstallRefused, match='protected_plist.py'):
        m.check_clone(files, STRANGER, frozenset(), anchor=anchor)


def test_a_deny_only_acl_grants_nothing_and_is_accepted(tmp_path):
    # Every macOS home carries `group:everyone deny delete`, so a clone in an administrator's home
    # passes such a folder. A deny entry only removes access; the mode bits still decide the rest.
    # (`user:nobody`, not `group:everyone`: the test user must still be able to delete the folder.)
    anchor, files = _clone(tmp_path)
    _acl(anchor / 'clone', 'user:nobody deny delete')
    m.check_clone(files, STRANGER, frozenset(), anchor=anchor)
    _acl(anchor / 'clone', 'user:nobody allow add_file')
    with pytest.raises(m.InstallRefused, match='clone'):
        m.check_clone(files, STRANGER, frozenset(), anchor=anchor)


def test_an_acl_that_cannot_be_read_is_refused(tmp_path, monkeypatch):
    anchor, files = _clone(tmp_path)

    def unreadable(path, kind):
        ctypes.set_errno(errno.EACCES)
        return None

    monkeypatch.setattr(m._libc, 'acl_get_link_np', unreadable)
    with pytest.raises(m.InstallRefused, match='ACL'):
        m.check_clone(files, STRANGER, frozenset(), anchor=anchor)


def _import_tree(tmp_path):
    """An import-path folder the bot user (STRANGER) cannot write: the test user owns it, 0755 and 0644."""
    anchor = tmp_path.resolve() / 'tree'
    stdlib = anchor / 'lib' / 'python3.9'
    cache = stdlib / 'encodings' / '__pycache__'
    cache.mkdir(parents=True)
    for module in (stdlib / 'plistlib.py', stdlib / 'encodings' / '__init__.py', cache / '__init__.cpython-39.pyc'):
        module.write_bytes(b'')
        module.chmod(0o644)
    _folders(anchor, anchor / 'lib', stdlib, stdlib / 'encodings', cache)
    return anchor, stdlib


# Codex Critical: root imports the modules INSIDE each import-path folder, so one the bot user can
# write runs as root on the next helper run, however trusted its folder. Tests cannot chown to the
# bot, so each case is a distinct way the bot gains write access to one entry below the folder.
@pytest.mark.parametrize('entry, opening', [
    pytest.param('plistlib.py', 'other-write', id='other-writable-module'),
    pytest.param('plistlib.py', 'group-write', id='group-writable-module'),
    pytest.param('plistlib.py', 'acl-allow', id='acl-writable-module'),
    pytest.param('encodings', 'other-write', id='writable-package-folder'),
    pytest.param('encodings/__pycache__/__init__.cpython-39.pyc', 'other-write', id='writable-bytecode'),
])
def test_a_bot_writable_entry_inside_a_trusted_import_folder_is_refused(tmp_path, entry, opening):
    anchor, stdlib = _import_tree(tmp_path)
    target = stdlib / entry
    groups = frozenset({os.lstat(target).st_gid}) if opening == 'group-write' else frozenset()
    # Positive control: the same tree, the same bot groups, nothing opened.
    m.check_interpreter([str(stdlib)], STRANGER, groups, anchor=anchor)
    if opening == 'acl-allow':
        _acl(target, 'user:nobody allow write')
    else:
        target.chmod(os.lstat(target).st_mode & 0o777 | (0o020 if opening == 'group-write' else 0o002))
    with pytest.raises(m.InstallRefused, match=str(target)):
        m.check_interpreter([str(stdlib)], STRANGER, groups, anchor=anchor)


def test_a_symlink_inside_an_import_folder_is_checked_along_its_target_chain(tmp_path):
    anchor, stdlib = _import_tree(tmp_path)
    outside = anchor / 'outside'
    outside.mkdir()
    (outside / 'helper.py').write_bytes(b'')
    _folders(outside)
    (outside / 'helper.py').chmod(0o644)
    (stdlib / 'helper.py').symlink_to(outside / 'helper.py')
    m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)
    outside.chmod(0o757)
    with pytest.raises(m.InstallRefused, match=str(outside)):
        m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)


def test_a_symlink_to_a_folder_inside_an_import_folder_is_refused(tmp_path):
    # Imports could reach modules below a linked folder, which the walk does not enter.
    anchor, stdlib = _import_tree(tmp_path)
    (stdlib / 'json').symlink_to(stdlib / 'encodings', target_is_directory=True)
    with pytest.raises(m.InstallRefused, match='json'):
        m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)


def _failing(monkeypatch, name, path):
    """Make os.<name> fail with EIO for `path` alone. os.path's helpers look the function up on os when called."""
    real = getattr(os, name)

    def failing(target, *args, **kwargs):
        if isinstance(target, (str, bytes, os.PathLike)) and os.fspath(target) == str(path):
            raise OSError(errno.EIO, os.strerror(errno.EIO), str(path))
        return real(target, *args, **kwargs)

    monkeypatch.setattr(m.os, name, failing)


def test_a_symlink_whose_target_cannot_be_inspected_is_refused(tmp_path, monkeypatch):
    # Codex regate3 Critical: os.path.isdir swallowed EIO on the link's final stat and returned False,
    # so a link to a trusted folder holding a bot-owned module was accepted and that folder never walked.
    anchor, stdlib = _import_tree(tmp_path)
    outside = anchor / 'outside'
    outside.mkdir()
    (outside / '__init__.py').write_bytes(b'')
    _folders(outside)
    link = stdlib / 'json'
    link.symlink_to(outside, target_is_directory=True)
    _failing(monkeypatch, 'stat', link)
    # The chain to the target is trusted, so only the failed stat can refuse.
    m.check_chain([str(link)], STRANGER, frozenset(), 'chain', anchor=anchor)
    with pytest.raises(m.InstallRefused, match='cannot inspect the target of ' + str(link)):
        m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)


def test_a_dangling_symlink_inside_an_import_folder_is_refused(tmp_path):
    # Any error on a link's target refuses, ENOENT included: the walk cannot say what an import would reach.
    anchor, stdlib = _import_tree(tmp_path)
    outside = anchor / 'outside'
    outside.mkdir()
    _folders(outside)
    link = stdlib / 'helper.py'
    link.symlink_to(outside / 'missing.py')
    with pytest.raises(m.InstallRefused, match='cannot inspect the target of ' + str(link)):
        m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)


def test_a_select_link_that_cannot_be_inspected_is_refused(tmp_path, monkeypatch):
    # os.path.lexists swallowed EIO and returned False, so the Command Line Tools stood in for the selected
    # developer folder and the select link's chain, the one /usr/bin/python3 follows, was never checked.
    _, select, _ = _alias_tree(tmp_path, 0o755)
    python = str(select / 'usr' / 'bin' / 'python3')
    _failing(monkeypatch, 'lstat', select)
    with pytest.raises(m.InstallRefused, match='cannot inspect ' + str(select)):
        m.interpreter_paths(executable=python, path_entries=[], select_link=str(select))
    with pytest.raises(m.InstallRefused, match='cannot inspect ' + str(select)):
        m.check_invocation(True, True, True, python, select_link=str(select))


def test_an_import_folder_that_cannot_be_listed_is_refused(tmp_path):
    anchor, stdlib = _import_tree(tmp_path)
    (stdlib / 'encodings').chmod(0)
    try:
        with pytest.raises(m.InstallRefused, match='encodings'):
            m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)
    finally:
        (stdlib / 'encodings').chmod(0o755)


def test_an_import_folder_beyond_the_walk_bound_is_refused(tmp_path, monkeypatch):
    anchor, stdlib = _import_tree(tmp_path)
    m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)
    monkeypatch.setattr(m, 'MAX_TREE_ENTRIES', 3)  # the tree holds 5 entries
    with pytest.raises(m.InstallRefused, match='entries'):
        m.check_interpreter([str(stdlib)], STRANGER, frozenset(), anchor=anchor)


def test_main_refuses_a_writable_clone_before_reading_it(monkeypatch):
    # The test user owns this worktree, so as the bot user it can write the clone.
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(m, 'check_invocation', lambda *args: None)
    reads = []
    monkeypatch.setattr(m, 'read_pin', lambda *args: reads.append('pin'))
    monkeypatch.setattr(m, 'read_bytes', lambda *args: reads.append('bytes'))
    with pytest.raises(m.InstallRefused, match='clone'):
        m.main(['--user', pwd.getpwuid(os.getuid()).pw_name])
    assert reads == []
    assert set(m.clone_paths()) == {str(m.HERE / 'install_root_helper.py'), str(m.PIN), str(m.HELPER)}


def test_main_reports_the_exact_sudoers_line_for_the_bot_user(monkeypatch, capsys):
    name = pwd.getpwuid(os.getuid()).pw_name
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(m, 'check_invocation', lambda *args: None)
    monkeypatch.setattr(m, 'check_clone', lambda paths, uid, groups, **_: None)
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
        'sudoers': f"{name} ALL = (root) NOPASSWD: /usr/bin/python3 -I -S -B {pin['path']}",
    }
