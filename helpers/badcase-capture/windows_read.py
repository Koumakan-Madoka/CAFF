"""Windows constrained-read primitive; NOT yet wired into capture capability.

Local drive-absolute NTFS directories only. Open each component relative to a
held NT directory handle with OBJ_DONT_REPARSE, reject reparse attributes too,
and omit FILE_SHARE_DELETE to prevent renaming held ancestors. All handles are
closed by ExitStack, including on identity mismatch. No pathname content reads,
realpath/WSL fallback, UNC, ADS, device namespace, or enumeration implementation.

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
    if bool(standard.Directory) != directory or standard.DeletePending:
        raise Refused("type_rejected")
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
    options = 0x20 | 0x200000 | (1 if directory else 0x40)  # sync, open-reparse, dir/non-dir
    status = nt.NtCreateFile(C.byref(out), 0x100081, C.byref(attrs), C.byref(io),
                             None, 0, 3, 1, options, None, 0)  # no SHARE_DELETE
    if status < 0:
        raise Refused("relative_open_rejected")
    handle = _hold(stack, out.value)
    _check(handle, directory)
    return handle


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
