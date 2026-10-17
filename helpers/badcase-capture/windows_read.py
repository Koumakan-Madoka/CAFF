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
import os
import re
import struct


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

    def walk(self, max_entries=100000, max_depth=64, _after_list=None):
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
        entries = []

        def visit(handle, prefix, depth):
            before = _directory_stamp(handle)
            names = _directory_names(handle, max_entries - len(entries))
            if _after_list is not None:
                _after_list(prefix)
            for name in sorted(names):
                if depth + 1 > max_depth:
                    raise Refused("depth_limit")
                if len(entries) >= max_entries:
                    raise Refused("entry_limit")
                relative = prefix + '/' + name if prefix else name
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

    def read(self, relative, max_bytes=64 * 1024 * 1024, _after_open=None):
        if self.handle is None:
            raise Refused("root_closed")
        if type(max_bytes) is not int or not 0 <= max_bytes <= 64 * 1024 * 1024:
            raise Refused("limit_invalid")
        parts = components(relative)
        with contextlib.ExitStack() as stack:
            handle = self.handle
            for i, part in enumerate(parts):
                handle = _relative(stack, handle, part, i < len(parts) - 1)
            before, standard = _check(handle, False)
            original_id = identity(handle)
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
