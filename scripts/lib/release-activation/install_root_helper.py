"""Install the root plist helper at its fixed root-owned path. The owner runs this once per host, as root.

    sudo /usr/bin/python3 -I -S -B <clone>/scripts/lib/release-activation/install_root_helper.py --user <bot-user>

Run it from a clone the bot user cannot write, checked out at the reviewed
commit: run from the bot's own release tree, the bot user could change this
script and the pin before root runs them.

The helper bytes are read once, compared with the digest in root-helper.json,
and those same bytes are written. The install folder and every ancestor must
be root-owned and not writable by group or other. Every entry the kernel
passes on the way to the interpreter sudo will run must be unwritable by the
bot user: each original path component, each symlink hop and each hop's
folders, checked before anything is resolved. `/usr/bin/python3` resolves
through the selected developer folder, and a bot user who can redirect or
replace that folder's `python3` would run code as root. Root also imports the
modules inside each import-path folder (`-S` drops site, not the standard
library), so every file and folder below those folders must be unwritable by
the bot user too.

"Unwritable by the bot user" covers ownership, the group and other write bits,
and ACLs: any ACL entry that is not a deny entry could grant the bot write
access, so it refuses. A deny-only ACL, like the one on every macOS home,
cannot grant access. ACLs are read with libc; the xattr list does not show them.
Re-running with an up-to-date install changes nothing.

Exit status: 0 installed or already current, 2 refused (nothing changed).
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import sys

HERE = Path(os.path.abspath(__file__)).parent
PIN = HERE / 'root-helper.json'
HELPER = HERE / 'protected_plist.py'
INSTALL_PATH = re.compile(r'/Library/PrivilegedHelperTools/[A-Za-z0-9][A-Za-z0-9._-]*')
SHA256 = re.compile(r'[0-9a-f]{64}')
SELECT_LINK = '/var/db/xcode_select_link'
COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools'
# The interpreter the sudoers rule names: a shim that runs the selected developer folder's python3.
ROOT_PYTHON = '/usr/bin/python3'
MAX_SYMLINK_HOPS = 32  # the kernel's MAXSYMLINKS
# Entries below one import-path folder; past this the walk refuses. Xcode's 3.9 standard library
# holds about 1,800 (measured); the bound only keeps a pathological tree finite.
MAX_TREE_ENTRIES = 200_000
ROOT = (0, 0)
FOLDER_MODE = 0o755
INSTALLED_MODE = 0o444
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
# <sys/acl.h>
ACL_TYPE_EXTENDED = 0x00000100
ACL_EXTENDED_DENY = 2
_ACL_FIRST_ENTRY, _ACL_NEXT_ENTRY = 0, -1
_ACL_MAX_ENTRIES = 1024  # the kernel allows 128; a bound keeps the entry loop finite

# No dir_fd form of mkdir, rename or unlink, and no ACL reader, in every interpreter this runs under,
# so these come from libc.
_libc = ctypes.CDLL(None, use_errno=True)
_libc.mkdirat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint16]
_libc.renameat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
_libc.unlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
_libc.acl_get_link_np.argtypes = [ctypes.c_char_p, ctypes.c_int]
_libc.acl_get_link_np.restype = ctypes.c_void_p
_libc.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
_libc.acl_get_tag_type.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
_libc.acl_free.argtypes = [ctypes.c_void_p]


class InstallRefused(RuntimeError):
    """The install did not happen; nothing was changed."""


def _checked(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def read_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return b''.join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def read_pin(path=PIN):
    """root-helper.json: the one record of where the helper is installed and which bytes it must have."""
    try:
        pin = json.loads(read_bytes(path))
    except (OSError, ValueError) as exc:
        raise InstallRefused('root-helper.json is unreadable') from exc
    if (not isinstance(pin, dict) or set(pin) != {'path', 'sha256'} or not isinstance(pin['path'], str)
            or not isinstance(pin['sha256'], str) or not INSTALL_PATH.fullmatch(pin['path'])
            or not SHA256.fullmatch(pin['sha256'])):
        raise InstallRefused('root-helper.json must hold a PrivilegedHelperTools path and a sha256')
    return pin


def parse_user(argv):
    if len(argv) != 2 or argv[0] != '--user' or not argv[1]:
        raise InstallRefused('usage: install_root_helper.py --user <bot-user>')
    return argv[1]


def bot_identity(name):
    """The bot user's uid and groups, from the user database."""
    try:
        user = pwd.getpwnam(name)
    except KeyError as exc:
        raise InstallRefused('--user names no account on this host') from exc
    if user.pw_uid == 0:
        raise InstallRefused('--user must be the bot account, not root')
    return user.pw_uid, frozenset(os.getgrouplist(user.pw_name, user.pw_gid))


def acl_tags(path):
    """The entry tags of `path`'s own extended ACL (a symlink's own, not its target's); None when it has none.

    The xattr list does not show ACLs, so libc reads them. NULL with ENOENT
    means no ACL (the caller has just lstat'ed `path`); any other failure refuses.
    """
    unreadable = InstallRefused('cannot read the ACL of ' + str(path))
    ctypes.set_errno(0)
    acl = _libc.acl_get_link_np(os.fsencode(path), ACL_TYPE_EXTENDED)
    if not acl:
        if ctypes.get_errno() == errno.ENOENT:
            return None
        raise unreadable
    try:
        tags = []
        entry = ctypes.c_void_p()
        which = _ACL_FIRST_ENTRY
        while _libc.acl_get_entry(acl, which, ctypes.byref(entry)) == 0:  # -1 past the last entry
            tag = ctypes.c_int()
            if _libc.acl_get_tag_type(entry, ctypes.byref(tag)) != 0 or len(tags) >= _ACL_MAX_ENTRIES:
                raise unreadable
            tags.append(tag.value)
            which = _ACL_NEXT_ENTRY
        return tuple(tags)
    finally:
        _libc.acl_free(acl)


def _writable_by(entry, info, uid, groups):
    """Could this user change the entry? An owner can always chmod, so ownership alone counts.

    So does any ACL entry but a deny entry: an allow entry may name this user
    or one of its groups. A deny entry only removes access.
    """
    mode = stat.S_IMODE(info.st_mode)
    if info.st_uid == uid or (mode & 0o020 and info.st_gid in groups) or mode & 0o002:
        return True
    tags = acl_tags(entry)
    return tags is not None and any(tag != ACL_EXTENDED_DENY for tag in tags)


def select_link_exists(select_link):
    """Is a developer folder selected? Only ENOENT means no; any other error refuses.

    os.path.lexists answers False on every error, and a False here would
    check the Command Line Tools in place of the folder /usr/bin/python3 runs.
    """
    try:
        os.lstat(select_link)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise InstallRefused('cannot inspect ' + str(select_link)) from exc
    return True


def check_invocation(isolated, no_site, no_bytecode, executable, select_link=SELECT_LINK):
    """The chain check below inspects whichever interpreter runs this script; it must be the one sudo will run.

    That is `/usr/bin/python3 -I -S -B`, which resolves to a python3 inside the
    selected developer folder (or the Command Line Tools). `-S` keeps
    site-packages and their .pth files off the import path being checked.
    """
    if not (isolated and no_site and no_bytecode):
        raise InstallRefused('run the install step as /usr/bin/python3 -I -S -B')
    roots = [Path(COMMAND_LINE_TOOLS)]
    if select_link_exists(select_link):
        roots.append(Path(os.path.realpath(select_link)))
    real = Path(os.path.realpath(executable))
    if not any(root in real.parents for root in roots):
        raise InstallRefused('run the install step as /usr/bin/python3, the interpreter the sudoers rule names')


def interpreter_paths(executable=None, path_entries=None, select_link=SELECT_LINK):
    """The ORIGINAL, unresolved paths root trusts when sudo runs ROOT_PYTHON: this same interpreter's.

    The shim sudo runs, this interpreter as invoked, the selected developer
    folder's python3 (the Command Line Tools when nothing is selected) and
    each import path entry. Resolving them first would discard the symlinks
    and folders the kernel passes through.
    """
    executable = sys.executable if executable is None else executable
    entries = sys.path if path_entries is None else path_entries
    developer = select_link if select_link_exists(select_link) else COMMAND_LINE_TOOLS
    paths = [ROOT_PYTHON, executable, developer + '/usr/bin/python3']
    paths += [entry if entry.startswith('/') else os.path.join(os.getcwd(), entry) for entry in entries if entry]
    return paths


def path_chain(path):
    """Yield (entry, lstat) for every entry the kernel passes to resolve the absolute `path`, symlinks included.

    Walks the original components from "/": each folder, each symlink itself,
    then its target's components, from "/" when absolute and from the link's
    folder otherwise; ".." leaves the folder actually reached, as the kernel
    does. A missing component ends the walk: its folder was yielded, and
    whoever can write that folder could create it.
    """
    pending = [part for part in reversed(str(path).split('/')) if part]
    current = Path('/')
    yield current, os.lstat(current)
    hops = 0
    while pending:
        part = pending.pop()
        if part == '.':
            continue
        if part == '..':
            current = current.parent
            continue
        entry = current / part
        try:
            info = os.lstat(entry)
        except FileNotFoundError:
            return
        yield entry, info
        if not stat.S_ISLNK(info.st_mode):
            current = entry
            continue
        hops += 1
        if hops > MAX_SYMLINK_HOPS:
            raise InstallRefused('too many symlinks on the way to ' + str(path))
        target = os.readlink(entry)
        if target.startswith('/'):
            current = Path('/')
        pending.extend(piece for piece in reversed(target.split('/')) if piece)


def check_chain(paths, uid, groups, consequence, *, anchor='/'):
    """Refuse when the bot user could change any entry on the way to these paths (from `anchor` down)."""
    anchor = Path(anchor)
    for raw in paths:
        for entry, info in path_chain(raw):
            if (entry == anchor or anchor in entry.parents) and _writable_by(entry, info, uid, groups):
                raise InstallRefused('the bot user can write ' + str(entry) + ', ' + consequence)


def tree_entries(folder, seen):
    """Yield (entry, lstat) for every entry below `folder`, never entering a symlink; any error refuses.

    `seen` holds the (device, inode) of folders already walked, so a folder
    reached twice (lib-dynload sits inside the standard library) is walked once.
    """
    pending = [Path(folder)]
    count = 0
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as listing:
                names = sorted(item.name for item in listing)
        except OSError as exc:
            raise InstallRefused('cannot list ' + str(current)) from exc
        for name in names:
            entry = current / name
            try:
                info = os.lstat(entry)
            except OSError as exc:
                raise InstallRefused('cannot inspect ' + str(entry)) from exc
            count += 1
            if count > MAX_TREE_ENTRIES:
                raise InstallRefused('more than ' + str(MAX_TREE_ENTRIES) + ' entries below ' + str(folder))
            yield entry, info
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) not in seen:
                seen.add((info.st_dev, info.st_ino))
                pending.append(entry)


def check_tree(folder, uid, groups, consequence, seen, *, anchor='/'):
    """Refuse when the bot user could change any entry below `folder`, or reach code outside it through a link.

    A symlink is checked like any other entry, then along its target chain. A
    link to a folder refuses: imports could reach files below it that this walk
    does not enter. So does a link whose target cannot be inspected, a dangling
    one included: os.path.isdir would answer False and admit it.
    """
    for entry, info in tree_entries(folder, seen):
        if _writable_by(entry, info, uid, groups):
            raise InstallRefused('the bot user can write ' + str(entry) + ', ' + consequence)
        if stat.S_ISLNK(info.st_mode):
            check_chain([entry], uid, groups, consequence, anchor=anchor)
            try:
                target = os.stat(entry)
            except OSError as exc:
                raise InstallRefused('cannot inspect the target of ' + str(entry) + ', ' + consequence) from exc
            if stat.S_ISDIR(target.st_mode):
                raise InstallRefused(str(entry) + ' links to a folder, ' + consequence)


def check_interpreter(paths, uid, groups, *, anchor='/'):
    """The chain to each path, then every entry below each path that is a folder: an import-path folder.

    Root imports the modules inside those folders, so their trust matters as
    much as the folders'. A missing path is skipped: its chain check covered
    the folder that could create it.
    """
    consequence = 'which the root interpreter trusts; select a root-owned developer folder'
    check_chain(paths, uid, groups, consequence, anchor=anchor)
    seen = set()
    for raw in paths:
        try:
            info = os.stat(raw)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise InstallRefused('cannot inspect ' + str(raw)) from exc
        if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) not in seen:
            seen.add((info.st_dev, info.st_ino))
            check_tree(raw, uid, groups, consequence, seen, anchor=anchor)


def clone_paths():
    """This script, the pin and the helper, as root reads them from the clone."""
    return [str(HERE / 'install_root_helper.py'), str(PIN), str(HELPER)]


def check_clone(paths, uid, groups, *, anchor='/'):
    """The whole chain from "/": a writable ancestor would let the bot user put another clone in its place."""
    check_chain(paths, uid, groups, 'on the path of the clone this install runs from; run it from a clone the bot '
                'user cannot write', anchor=anchor)


def _trusted_folder(fd, owner):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner[0] or stat.S_IMODE(info.st_mode) & 0o022:
        raise InstallRefused('install folders must be root-owned and not writable by group or other')


def open_install_folder(anchor, parts, owner):
    """Open anchor/parts one component at a time without following a symlink; create only the last one."""
    fd = os.open(anchor, _DIRECTORY)
    try:
        _trusted_folder(fd, owner)
        for index, part in enumerate(parts):
            try:
                child = os.open(part, _DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if index != len(parts) - 1:
                    raise InstallRefused('install folder ancestor is missing') from None
                _checked(_libc.mkdirat(fd, os.fsencode(part), FOLDER_MODE))
                child = os.open(part, _DIRECTORY, dir_fd=fd)
                os.fchown(child, *owner)
                os.fchmod(child, FOLDER_MODE)
            except OSError as exc:
                raise InstallRefused('install folder path must contain no symlink') from exc
            os.close(fd)
            fd = child
            _trusted_folder(fd, owner)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _current(folder_fd, name, data, owner):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder_fd)
    except OSError:
        return False
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != tuple(owner)
                or stat.S_IMODE(info.st_mode) != INSTALLED_MODE or info.st_nlink != 1):
            return False
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return b''.join(chunks) == data
            chunks.append(chunk)
    finally:
        os.close(fd)


def install(data, pin, *, anchor='/', owner=ROOT):
    """Install `data` at the pinned path below `anchor`, owned by `owner`, mode 0444; idempotent."""
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise InstallRefused('helper bytes do not match root-helper.json; run from a clone at the reviewed commit')
    *parts, name = Path(pin['path']).relative_to('/').parts
    folder_fd = open_install_folder(anchor, parts, owner)
    try:
        if _current(folder_fd, name, data, owner):
            return {'changed': False}
        temporary = '.' + name + '.install-' + secrets.token_hex(8)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder_fd)
        except FileExistsError as exc:
            raise InstallRefused('a temporary install file already exists; inspect the install folder') from exc
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
            os.fchown(fd, *owner)
            os.fchmod(fd, INSTALLED_MODE)
            os.close(fd)
            fd = None
            _checked(_libc.renameat(folder_fd, os.fsencode(temporary), folder_fd, os.fsencode(name)))
        except BaseException:
            if fd is not None:
                os.close(fd)
            _libc.unlinkat(folder_fd, os.fsencode(temporary), 0)
            raise
        os.fsync(folder_fd)
        if not _current(folder_fd, name, data, owner):
            raise InstallRefused('installed helper did not verify after the rename')
        return {'changed': True}
    finally:
        os.close(folder_fd)


def main(argv):
    name = parse_user(argv)
    if os.geteuid() != 0:
        raise InstallRefused('run the install step as root (sudo)')
    check_invocation(sys.flags.isolated, sys.flags.no_site, sys.dont_write_bytecode, sys.executable)
    uid, groups = bot_identity(name)
    check_clone(clone_paths(), uid, groups)
    pin = read_pin()
    data = read_bytes(HELPER)
    check_interpreter(interpreter_paths(), uid, groups)
    result = install(data, pin)
    result.update(path=pin['path'], sha256=pin['sha256'],
                  sudoers=name + ' ALL = (root) NOPASSWD: ' + ROOT_PYTHON + ' -I -S -B ' + pin['path'])
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (InstallRefused, OSError) as exc:
        print(json.dumps({'refused': str(exc)}), file=sys.stderr)
        sys.exit(2)
