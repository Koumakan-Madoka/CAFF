"""Windows constrained-read primitive; NOT yet wired into capture capability.

Local drive-absolute NTFS directories only. Open each component relative to a
held NT directory handle with OBJ_DONT_REPARSE, reject reparse attributes too,
and omit FILE_SHARE_DELETE to prevent renaming held ancestors. All handles are
closed by ExitStack, including on identity mismatch. No pathname content reads,
realpath/WSL fallback, UNC, ADS, device namespace, or pathname enumeration.

Root identity uses decimal/hex strings (no JavaScript integer rounding). This
pins objects, not an atomic multi-file snapshot. Same-OS-user native code and
Python interpreter remain trusted. File IDs can eventually be reused; creation
time narrows but does not mathematically eliminate that residual.
"""
import contextlib
import ctypes as C
import hashlib
import json
import os
import re
import struct
import sys


class Refused(Exception):
    """Fixed public reason only; never includes a path or OS error text."""


if os.name == "nt":
    U32, U16, I64, U64 = C.c_uint32, C.c_uint16, C.c_int64, C.c_uint64
    HANDLE = C.c_void_p
    kernel = C.WinDLL("kernel32", use_last_error=True)
    nt = C.WinDLL("ntdll")

    class UnicodeString(C.Structure):
        _fields_ = [("Length", U16), ("MaximumLength", U16), ("Buffer", C.c_void_p)]

    class ObjectAttributes(C.Structure):
        _fields_ = [("Length", U32), ("RootDirectory", HANDLE),
                    ("ObjectName", C.POINTER(UnicodeString)), ("Attributes", U32),
                    ("SecurityDescriptor", C.c_void_p), ("SecurityQualityOfService", C.c_void_p)]

    class IoStatus(C.Structure):
        _fields_ = [("Status", C.c_void_p), ("Information", C.c_size_t)]

    class BasicInfo(C.Structure):
        _fields_ = [("CreationTime", I64), ("LastAccessTime", I64),
                    ("LastWriteTime", I64), ("ChangeTime", I64), ("FileAttributes", U32)]

    class StandardInfo(C.Structure):
        _fields_ = [("AllocationSize", I64), ("EndOfFile", I64), ("NumberOfLinks", U32),
                    ("DeletePending", C.c_ubyte), ("Directory", C.c_ubyte)]

    class CaseSensitiveInfo(C.Structure):
        _fields_ = [("Flags", U32)]

    class IdInfo(C.Structure):
        _fields_ = [("VolumeSerialNumber", U64), ("FileId", C.c_ubyte * 16)]

    kernel.CreateFileW.argtypes = [C.c_wchar_p, U32, U32, C.c_void_p, U32, U32, HANDLE]
    kernel.CreateFileW.restype = HANDLE
    kernel.CloseHandle.argtypes = [HANDLE]
    kernel.CloseHandle.restype = C.c_int
    kernel.GetFileInformationByHandleEx.argtypes = [HANDLE, C.c_int, C.c_void_p, U32]
    kernel.GetFileInformationByHandleEx.restype = C.c_int
    kernel.GetVolumeInformationByHandleW.argtypes = [HANDLE, C.c_wchar_p, U32, C.POINTER(U32),
                                                    C.POINTER(U32), C.POINTER(U32), C.c_wchar_p, U32]
    kernel.GetVolumeInformationByHandleW.restype = C.c_int
    kernel.GetDriveTypeW.argtypes = [C.c_wchar_p]
    kernel.GetDriveTypeW.restype = U32
    kernel.GetFileType.argtypes = [HANDLE]
    kernel.GetFileType.restype = U32
    kernel.ReadFile.argtypes = [HANDLE, C.c_void_p, U32, C.POINTER(U32), C.c_void_p]
    kernel.ReadFile.restype = C.c_int
    nt.NtCreateFile.argtypes = [C.POINTER(HANDLE), U32, C.POINTER(ObjectAttributes),
                               C.POINTER(IoStatus), C.c_void_p, U32, U32, U32, U32, C.c_void_p, U32]
    nt.NtCreateFile.restype = C.c_int32
    nt.NtQueryDirectoryFile.argtypes = [HANDLE, HANDLE, C.c_void_p, C.c_void_p,
                                        C.POINTER(IoStatus), C.c_void_p, U32, C.c_int,
                                        C.c_ubyte, C.POINTER(UnicodeString), C.c_ubyte]
    nt.NtQueryDirectoryFile.restype = C.c_int32
    nt.RtlEqualUnicodeString.argtypes = [C.POINTER(UnicodeString), C.POINTER(UnicodeString), C.c_ubyte]
    nt.RtlEqualUnicodeString.restype = C.c_ubyte


def components(value):
    """Conservative portable names, no NT/Win32 alias or path interpretation."""
    if not isinstance(value, str) or not value or "\\" in value:
        raise Refused("path_invalid")
    parts = value.split("/")
    for part in parts:
        if (not part or part in (".", "..") or part[-1] in " ."
                or any(ord(ch) < 32 or ch in '<>:"|?*' or 0xD800 <= ord(ch) <= 0xDFFF for ch in part)
                or len(part.encode("utf-16-le")) > 510
                or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?", part)):
            raise Refused("path_invalid")
    return parts


def _query(handle, info_type, struct_type):
    value = struct_type()
    if not kernel.GetFileInformationByHandleEx(handle, info_type, C.byref(value), C.sizeof(value)):
        raise Refused("metadata_unavailable")
    return value


def identity(handle):
    basic = _query(handle, 0, BasicInfo)
    ident = _query(handle, 18, IdInfo)
    return {"volumeSerial": str(ident.VolumeSerialNumber),
            "fileId": bytes(ident.FileId).hex(), "creationTime": str(basic.CreationTime)}


def _check(handle, directory):
    if kernel.GetFileType(handle) != 1:
        raise Refused("not_disk_file")
    basic = _query(handle, 0, BasicInfo)
    standard = _query(handle, 1, StandardInfo)
    if basic.FileAttributes & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
        raise Refused("reparse_rejected")
    if (directory is not None and bool(standard.Directory) != directory) or standard.DeletePending:
        raise Refused("type_rejected")
    if standard.Directory and _query(handle, 23, CaseSensitiveInfo).Flags != 0:
        # OBJ_CASE_INSENSITIVE opens must not alias distinct A/a entries in a
        # Windows directory opted into case sensitivity (e.g. WSL interop).
        raise Refused("case_sensitive_unsupported")
    return basic, standard


def _hold(stack, handle):
    stack.callback(kernel.CloseHandle, handle)
    return handle


def _relative(stack, parent, name, directory):
    # name is exactly ONE validated component, so every ancestor is explicitly
    # opened and held. OBJ_DONT_REPARSE rejects intermediate and final reparses;
    # OPEN_REPARSE_POINT + attribute check also rejects rather than follows.
    components(name)
    if "/" in name:
        raise Refused("path_invalid")
    text = C.create_unicode_buffer(name)
    length = len(name.encode("utf-16-le"))
    string = UnicodeString(length, length + 2, C.cast(text, C.c_void_p))
    attrs = ObjectAttributes(C.sizeof(ObjectAttributes), parent, C.pointer(string), 0x1040, None, None)
    io = IoStatus()
    out = HANDLE()
    options = 0x20 | 0x200000 | (0 if directory is None else (1 if directory else 0x40))
    status = nt.NtCreateFile(C.byref(out), 0x100081, C.byref(attrs), C.byref(io),
                             None, 0, 3, 1, options, None, 0)  # no SHARE_DELETE
    if status < 0:
        raise Refused("relative_open_rejected")
    handle = _hold(stack, out.value)
    _check(handle, directory)
    return handle


def _parse_names(data):
    """Bounded FILE_NAMES_INFORMATION chain; native names never become paths."""
    names, offset = [], 0
    while True:
        if len(data) - offset < 12:
            raise Refused("enumeration_invalid")
        next_offset, _, length = struct.unpack_from('<III', data, offset)
        end = offset + 12 + length
        if not length or length % 2 or end > len(data):
            raise Refused("enumeration_invalid")
        try:
            name = data[offset + 12:end].decode('utf-16-le', errors='strict')
        except UnicodeError:
            raise Refused("enumeration_invalid") from None
        if name not in ('.', '..'):
            components(name)
            if '/' in name:
                raise Refused("path_invalid")
            names.append(name)
        if next_offset == 0:
            return names
        if next_offset % 4 or next_offset < 12 + length or offset + next_offset >= len(data):
            raise Refused("enumeration_invalid")
        offset += next_offset


def _directory_names(handle, limit):
    # FileNamesInformation=12. The directory was opened synchronously; no event,
    # APC or asynchronous completion. Enumerate the held object, not its path.
    result, seen, restart = [], set(), True
    for _ in range(limit + 3):
        buffer = C.create_string_buffer(64 * 1024)
        io = IoStatus()
        status = nt.NtQueryDirectoryFile(handle, None, None, None, C.byref(io),
                                         buffer, len(buffer), 12, 0, None, int(restart))
        restart = False
        if status == -2147483642:  # STATUS_NO_MORE_FILES (0x80000006)
            return result
        if status != 0:  # includes BUFFER_OVERFLOW, no partial/truncated fallback
            raise Refused("enumeration_failed")
        if not 0 < io.Information <= len(buffer):
            raise Refused("enumeration_invalid")
        for name in _parse_names(buffer.raw[:io.Information]):
            if name in seen:
                raise Refused("directory_changed")
            seen.add(name)
            result.append(name)
            if len(result) > limit:
                raise Refused("entry_limit")
    raise Refused("enumeration_failed")


def _directory_stamp(handle):
    basic, _ = _check(handle, True)
    return (identity(handle), basic.LastWriteTime, basic.ChangeTime, basic.FileAttributes)


def _excluded_prefixes(excluded):
    # Literal relative prefixes, not globs. The management layer must compile
    # its policy grammar explicitly before calling this primitive.
    if not isinstance(excluded, (list, tuple)) or len(excluded) > 256:
        raise Refused('exclusions_invalid')
    return [components(value) for value in excluded]


def _nt_equal(left, right):
    # Use the same NT case-insensitive comparison as object-name opens, not
    # Python/JS locale folding (nor a guessed NTFS uppercase table).
    a, b = C.create_unicode_buffer(left), C.create_unicode_buffer(right)
    al, bl = len(left.encode('utf-16-le')), len(right.encode('utf-16-le'))
    au = UnicodeString(al, al + 2, C.cast(a, C.c_void_p))
    bu = UnicodeString(bl, bl + 2, C.cast(b, C.c_void_p))
    return bool(nt.RtlEqualUnicodeString(C.byref(au), C.byref(bu), 1))


def _excluded_path(relative, prefixes):
    parts = relative.split('/')
    return any(len(prefix) <= len(parts) and all(_nt_equal(a, b) for a, b in zip(prefix, parts))
               for prefix in prefixes)


# Metadata preview's conservative, versioned deny names. Not a universal secret
# detector. Prune before opening a child; names in its parent remain observable.
METADATA_DENY_NAMES = ('.git', '.pi', '.pi-sandbox', '.ssh', '.aws', '.azure', '.gnupg',
                       '.env', 'auth.json', 'credentials.json')


def _metadata_denied(name):
    return (any(_nt_equal(name, forbidden) for forbidden in METADATA_DENY_NAMES)
            or (len(name) > 5 and _nt_equal(name[:5], '.env.')))


class Root:
    """Owns all ancestor handles. Use only as a context manager."""
    def __init__(self, absolute, expected=None):
        self.absolute = absolute
        self.expected = expected
        self.stack = None
        self.handle = None

    def __enter__(self):
        if os.name != "nt":
            raise Refused("windows_required")
        if self.stack is not None:
            raise Refused("root_already_open")
        # Only local drive syntax; no UNC, extended namespace input or aliases.
        match = re.fullmatch(r"([A-Za-z]):[\\/](.*)", self.absolute) if isinstance(self.absolute, str) else None
        if not match:
            raise Refused("root_path_invalid")
        suffix = match[2].replace("\\", "/")
        parts = components(suffix) if suffix else []
        stack = contextlib.ExitStack()
        try:
            drive_root = match[1].upper() + ":\\"
            if kernel.GetDriveTypeW(drive_root) != 3:  # DRIVE_FIXED; no mapped SMB/removable drive
                raise Refused("drive_unsupported")
            drive = "\\\\?\\" + drive_root
            handle = kernel.CreateFileW(drive, 0x100081, 3, None, 3, 0x02200000, None)
            if handle in (None, C.c_void_p(-1).value):
                raise Refused("root_open_rejected")
            _hold(stack, handle)
            _check(handle, True)
            fsname = C.create_unicode_buffer(32)
            if not kernel.GetVolumeInformationByHandleW(handle, None, 0, None, None, None, fsname, 32) or fsname.value != "NTFS":
                raise Refused("filesystem_unsupported")
            for part in parts:
                handle = _relative(stack, handle, part, True)
            actual = identity(handle)
            if self.expected is not None and actual != self.expected:
                raise Refused("root_identity_mismatch")
            self.handle, self.identity, self.stack = handle, actual, stack
            return self
        except BaseException:
            stack.close()
            raise

    def __exit__(self, *args):
        if self.stack is not None:
            self.stack.close()
        self.stack = self.handle = None

    def walk(self, max_entries=100000, max_depth=64, _after_list=None, excluded=(), _metadata_only=False, _git_metadata=False):
        """Metadata-only tree enumeration. Not a coherent multi-file snapshot.

        Parent handles are held until their subtree completes. Each child is
        opened relative to that parent and checked, never via a pathname scan.
        The in-process test seam is not exposed through a CLI or agent API.
        """
        if self.handle is None:
            raise Refused("root_closed")
        if (type(max_entries) is not int or not 1 <= max_entries <= 100000
                or type(max_depth) is not int or not 1 <= max_depth <= 64):
            raise Refused("limit_invalid")
        prefixes = _excluded_prefixes(excluded)
        entries = []

        def visit(handle, prefix, depth):
            before = _directory_stamp(handle)
            names = _directory_names(handle, max_entries - len(entries))
            if _after_list is not None:
                _after_list(prefix)
            for name in sorted(names):
                relative = prefix + '/' + name if prefix else name
                # Never open/stat/recurse an excluded child, including reparses.
                # Parent-directory names are necessarily read to prune children.
                if _excluded_path(relative, prefixes):
                    continue
                if _git_metadata and _nt_equal(name, '.git'):
                    # Only the literal top-level repository marker. Never
                    # silently treat a nested repository/case alias as absent.
                    if relative != '.git':
                        raise Refused('git_metadata_unsupported')
                elif _metadata_only and _metadata_denied(name):
                    continue
                if _git_metadata and relative.startswith('.git/') and relative not in GIT_METADATA_PATHS:
                    continue  # objects/hooks/refs/etc are not opened or listed
                if depth + 1 > max_depth:
                    raise Refused("depth_limit")
                if len(entries) >= max_entries:
                    raise Refused("entry_limit")
                with contextlib.ExitStack() as stack:
                    child = _relative(stack, handle, name, None)
                    basic, standard = _check(child, None)
                    directory = bool(standard.Directory)
                    if standard.EndOfFile < 0:
                        raise Refused("metadata_unavailable")
                    entries.append({"path": relative, "type": "directory" if directory else "file",
                                    "size": 0 if directory else standard.EndOfFile, "identity": identity(child),
                                    "lastWriteTime": str(basic.LastWriteTime), "changeTime": str(basic.ChangeTime)})
                    if directory:
                        visit(child, relative, depth + 1)
            if _directory_stamp(handle) != before:
                raise Refused("directory_changed")

        visit(self.handle, '', 0)
        return sorted(entries, key=lambda entry: entry['path'])

    def read(self, relative, max_bytes=64 * 1024 * 1024, _after_open=None, expected_identity=None, _canonical=False):
        if self.handle is None:
            raise Refused("root_closed")
        if type(max_bytes) is not int or not 0 <= max_bytes <= 64 * 1024 * 1024:
            raise Refused("limit_invalid")
        parts = components(relative)
        with contextlib.ExitStack() as stack:
            handle = self.handle
            for i, part in enumerate(parts):
                # Session inputs are independently authorized exact files, not
                # whole-tree snapshots. Inspect only each held parent naming
                # table, never descend into unrelated children. Exact canonical
                # membership rejects case/8.3 aliases before opening that child.
                if _canonical and part not in _directory_names(handle, 100000):
                    raise Refused('path_not_in_manifest')
                handle = _relative(stack, handle, part, i < len(parts) - 1)
            before, standard = _check(handle, False)
            original_id = identity(handle)
            if expected_identity is not None and original_id != expected_identity:
                raise Refused('file_identity_mismatch')
            size = standard.EndOfFile
            if size < 0 or size > max_bytes:
                raise Refused("too_large")
            if _after_open is not None:  # in-process test seam; never a CLI option
                _after_open()
            chunks = []
            remaining = size
            while remaining:
                buffer = C.create_string_buffer(min(remaining, 1024 * 1024))
                count = U32()
                if not kernel.ReadFile(handle, buffer, len(buffer), C.byref(count), None):
                    raise Refused("read_failed")
                if count.value == 0:
                    raise Refused("short_read")
                chunks.append(buffer.raw[:count.value])
                remaining -= count.value
            after, final = _check(handle, False)
            if (identity(handle) != original_id or final.EndOfFile != size
                    or after.LastWriteTime != before.LastWriteTime or after.ChangeTime != before.ChangeTime
                    or after.FileAttributes != before.FileAttributes):
                raise Refused("changed_during_read")
            content = b"".join(chunks)
            return {"content": content, "sha256": hashlib.sha256(content).hexdigest(),
                    "size": size, "identity": original_id}


# Standalone protocol: one bounded JSON request on stdin, one JSON header plus
# concatenated exact-size file bodies on stdout. No partial success on refusal.
REQUEST_LIMIT = 1024 * 1024
HEADER_LIMIT = 32 * 1024 * 1024
BODY_LIMIT = 128 * 1024 * 1024
FILE_LIMIT = 64 * 1024 * 1024
SNAPSHOT_FILE_LIMIT = 2048
# Exact bounded sources only. No include/excludesFile/commondir/gitdir expansion.
GIT_METADATA_PATHS = frozenset(['.git/config', '.git/index', '.git/commondir', '.git/info', '.git/info/exclude'])
# Independently pinned external metadata root. Fixed names only; contents of
# gitdir/commondir are returned as bytes, NEVER resolved or followed here.
GIT_INPUT_PATHS = frozenset(['config', 'index', 'commondir', 'gitdir', 'config.worktree', 'info/exclude'])


def _git_source(relative):
    return (relative == '.git' or relative in GIT_METADATA_PATHS
            or relative.split('/')[-1] == '.gitignore')


PUBLIC_REASONS = frozenset([
    'request_invalid', 'helper_failed', 'windows_required', 'root_path_invalid',
    'path_invalid', 'root_open_rejected', 'drive_unsupported', 'filesystem_unsupported',
    'metadata_unavailable', 'not_disk_file', 'reparse_rejected', 'type_rejected',
    'case_sensitive_unsupported', 'relative_open_rejected', 'root_identity_mismatch',
    'file_identity_mismatch', 'enumeration_failed', 'enumeration_invalid',
    'directory_changed', 'entry_limit', 'depth_limit', 'limit_invalid',
    'path_not_in_manifest', 'too_large', 'read_failed', 'short_read',
    'changed_during_read', 'output_limit', 'estimate_scope_rejected', 'snapshot_changed', 'git_metadata_unsupported',
])


def _decimal(value, low, high):
    if not isinstance(value, str) or not re.fullmatch(r'0|-?[1-9][0-9]{0,19}', value):
        return False
    return low <= int(value) <= high


def _valid_identity(value):
    return (type(value) is dict and set(value) == {'volumeSerial', 'fileId', 'creationTime'}
            and _decimal(value['volumeSerial'], 0, (1 << 64) - 1)
            and isinstance(value['fileId'], str) and re.fullmatch('[0-9a-f]{32}', value['fileId'])
            and _decimal(value['creationTime'], -(1 << 63), (1 << 63) - 1))


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused('request_invalid')
        result[key] = value
    return result


def _request(stream):
    try:
        data = stream.read(REQUEST_LIMIT + 1)
        if len(data) > REQUEST_LIMIT:
            raise Refused('request_invalid')
        def invalid_constant(_):
            raise Refused('request_invalid')
        value = json.loads(data.decode('utf-8', errors='strict'), object_pairs_hook=_unique_object,
                           parse_constant=invalid_constant)
        if type(value) is not dict or type(value.get('version')) is not int or value['version'] != 1:
            raise Refused('request_invalid')
        op = value.get('op')
        keys = {'version', 'op', 'root'}
        if op in ('capture', 'estimate', 'snapshot', 'gitMetadata', 'selectedSnapshot'):
            keys |= {'expected', 'excluded'}
            if op in ('capture', 'selectedSnapshot'):
                keys.add('paths')
        elif op in ('sessionInput', 'gitInput'):
            keys |= {'expected', 'path'}
        elif op != 'identity':
            raise Refused('request_invalid')
        if set(value) != keys or not isinstance(value['root'], str):
            raise Refused('request_invalid')
        match = re.fullmatch(r'([A-Za-z]):[\\/](.*)', value['root'])
        if not match or len(value['root'].encode('utf-8')) > 32768:
            raise Refused('request_invalid')
        suffix = match[2].replace('\\', '/')
        if suffix:
            components(suffix)
        if op in ('sessionInput', 'gitInput'):
            if (not _valid_identity(value['expected']) or not isinstance(value['path'], str)
                    or (op == 'sessionInput' and not value['path'].endswith('.jsonl'))
                    or (op == 'gitInput' and value['path'] not in GIT_INPUT_PATHS)
                    or len(value['path'].encode('utf-8')) > 32768
                    or len(components(value['path'])) > 64):
                raise Refused('request_invalid')
        if op in ('capture', 'estimate', 'snapshot', 'gitMetadata', 'selectedSnapshot'):
            if not _valid_identity(value['expected']):
                raise Refused('request_invalid')
            _excluded_prefixes(value['excluded'])
            paths = value.get('paths', [])
            if (type(paths) is not list or len(paths) > 2048
                    or any(not isinstance(p, str) for p in paths) or len(set(paths)) != len(paths)):
                raise Refused('request_invalid')
            for relative in paths:
                components(relative)
                if len(relative.encode('utf-8')) > 32768:
                    raise Refused('request_invalid')
        return value
    except Exception:
        raise Refused('request_invalid') from None


def _snapshot(root, excluded, paths=None, git_metadata=False):
    """Bounded two-content-read candidate, NOT an atomic snapshot.

    Hold the authorized root for all passes. Three metadata walks bracket the
    two full reads. Fail the entire response on drift; never return partial
    bytes. Secret detection belongs to the trusted host BEFORE CAS/staging.
    Git/ignored classification belongs to the trusted host. A selected snapshot
    accepts only exact canonical file members, preflighting ALL before reading.
    The separate metadata operation reads only fixed classification sources.
    """
    def walk():
        return root.walk(excluded=excluded, _metadata_only=True, _git_metadata=git_metadata)
    entries = walk()
    if git_metadata and any(e['path'] in GIT_METADATA_PATHS and e['type'] !=
                            ('directory' if e['path'] == '.git/info' else 'file') for e in entries):
        raise Refused('git_metadata_unsupported')
    manifest = {e['path']: e for e in entries if e['type'] == 'file'}
    if paths is not None and any(p not in manifest for p in paths):
        raise Refused('path_not_in_manifest')
    selected = ([manifest[p] for p in paths] if paths is not None
                else [e for e in entries if e['type'] == 'file' and (not git_metadata or _git_source(e['path']))])
    if len(selected) > SNAPSHOT_FILE_LIMIT:
        raise Refused('entry_limit')
    if any(e['size'] > FILE_LIMIT for e in selected) or sum(e['size'] for e in selected) > BODY_LIMIT:
        raise Refused('too_large')
    files, bodies = [], []
    for entry in selected:
        value = root.read(entry['path'], FILE_LIMIT, expected_identity=entry['identity'])
        if value['size'] != entry['size']:
            raise Refused('snapshot_changed')
        bodies.append(value['content'])
        files.append({'path': entry['path'], 'size': str(value['size']),
                      'sha256': value['sha256'], 'identity': value['identity']})
    if walk() != entries:
        raise Refused('snapshot_changed')
    for entry, first in zip(selected, files):
        value = root.read(entry['path'], FILE_LIMIT, expected_identity=entry['identity'])
        if (value['size'] != entry['size'] or value['sha256'] != first['sha256']
                or value['identity'] != first['identity']):
            raise Refused('snapshot_changed')
    if walk() != entries:
        raise Refused('snapshot_changed')
    return entries, files, bodies


def serve(input_stream, output_stream):
    try:
        request = _request(input_stream)  # all syntax validated before target open
        bodies = []
        if request['op'] in ('estimate', 'snapshot', 'gitMetadata', 'selectedSnapshot') and any(_metadata_denied(p) for p in request['root'][3:].replace('\\', '/').split('/') if p):
            raise Refused('estimate_scope_rejected')
        with Root(request['root'], request.get('expected')) as root:
            header = {'version': 1, 'ok': True, 'identity': root.identity}
            if request['op'] in ('sessionInput', 'gitInput'):
                # No walk, Git discovery, directory expansion or caller hooks.
                # gitInput permits only fixed names under its own authorized
                # root, including binary index. Pointer text never grants access.
                # Two reads bind the returned bytes to one identity/hash; this
                # is change detection, not an atomic or ABA-proof snapshot.
                first = root.read(request['path'], FILE_LIMIT, _canonical=True)
                second = root.read(request['path'], FILE_LIMIT, _canonical=True)
                if any(first[k] != second[k] for k in ('identity', 'size', 'sha256')):
                    raise Refused('snapshot_changed')
                header['file'] = {'path': request['path'], 'size': str(first['size']),
                                  'sha256': first['sha256'], 'identity': first['identity']}
                bodies = [first['content']]
            elif request['op'] in ('snapshot', 'gitMetadata', 'selectedSnapshot'):
                entries, files, bodies = _snapshot(root, request['excluded'],
                                                  request.get('paths'), request['op'] == 'gitMetadata')
                header['entries'] = [{**e, 'size': str(e['size'])} for e in entries]
                header['files'] = files
            elif request['op'] in ('capture', 'estimate'):
                entries = root.walk(excluded=request['excluded'], _metadata_only=request['op'] == 'estimate')
                manifest = {e['path']: e for e in entries if e['type'] == 'file'}
                # Exact canonical membership prevents case and 8.3 aliases from
                # opening paths omitted by policy. Preflight ALL before reading.
                if any(p not in manifest for p in request.get('paths', [])):
                    raise Refused('path_not_in_manifest')
                files, remaining = [], BODY_LIMIT
                for relative in request.get('paths', []):
                    entry = manifest[relative]
                    value = root.read(relative, min(FILE_LIMIT, remaining),
                                      expected_identity=entry['identity'])
                    if value['size'] != entry['size']:
                        raise Refused('changed_during_read')
                    bodies.append(value['content'])
                    remaining -= value['size']
                    files.append({'path': relative, 'size': str(value['size']),
                                  'sha256': value['sha256'], 'identity': value['identity']})
                # Every 64-bit native quantity crosses JSON as an exact string.
                header['entries'] = [{**e, 'size': str(e['size'])} for e in entries]
                header['files'] = files
            encoded = json.dumps(header, ensure_ascii=True, separators=(',', ':')).encode('ascii')
            if len(encoded) > HEADER_LIMIT:
                raise Refused('output_limit')
        # No target handle is left open while the response pipe is drained.
    except BaseException as error:
        reason = error.args[0] if type(error) is Refused and len(error.args) == 1 else 'helper_failed'
        if not isinstance(reason, str) or reason not in PUBLIC_REASONS:
            reason = 'helper_failed'
        encoded = json.dumps({'version': 1, 'ok': False, 'code': reason}, separators=(',', ':')).encode('ascii')
        bodies = []
    output_stream.write(encoded + b'\n')
    for content in bodies:
        output_stream.write(content)


if __name__ == '__main__':
    # -I -B is required by the host adapter. No hooks or target paths in argv.
    if len(sys.argv) != 1:
        sys.stdout.buffer.write(b'{"version":1,"ok":false,"code":"request_invalid"}\n')
    else:
        serve(sys.stdin.buffer, sys.stdout.buffer)
