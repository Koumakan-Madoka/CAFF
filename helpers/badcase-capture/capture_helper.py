#!/usr/bin/env python3
"""badcase-capture constrained-read helper (protocol v1).

Runs under a capture root directory file descriptor inherited from the parent
Node process (stdio fd 3). All target-tree content is opened with the
openat2() syscall relative to that directory object with:

    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV

so path resolution happens inside the kernel, constrained to the pinned
directory object: renaming/replacing/swapping any path component (ABA races)
cannot redirect a read outside the authorized tree, symlinks and bind mounts
are rejected by the kernel, and ".." escape attempts fail with EXDEV.

Only regular files are returned. FIFOs/devices/sockets are rejected after a
non-blocking open (O_NONBLOCK prevents FIFO open from blocking). Each file is
fstat()ed before and after the read; metadata drift is reported as
"changed_during_read" instead of returning unstable bytes.

stdin protocol (one JSON object per line):
  {"op": "statx_root"}                       -> root identity via statx(fd)
  {"op": "read", "path": "rel/path", "maxBytes": N}
  {"op": "end"}

stdout protocol:
  statx_root -> {"ok": true, "devMajor": n, "devMinor": n, "ino": n,
                 "btimeSec": n, "btimeNsec": n, "btimeSupported": bool}
  read ok    -> header line {"ok": true, "size": N, "mode": M, "mtimeNs": T,
                 "mtimeMs": F, "sha256": "hex"} followed by exactly N raw bytes and "\n"
  read fail  -> single line {"ok": false, "code": "...", "errno": N}

Exit code 2 means the helper could not initialize (caller treats the whole
capture as unavailable; there is no fallback read path).
"""

import ctypes
import hashlib
import json
import os
import stat
import struct
import sys

SYS_OPENAT2 = 437  # x86_64; overridden below for aarch64
SYS_STATX = 332

import platform

if platform.machine() in ("aarch64", "arm64"):
    SYS_OPENAT2 = 437
    SYS_STATX = 291

O_RDONLY = 0
O_CLOEXEC = 0o2000000
O_NONBLOCK = 0o0004000
RESOLVE_NO_XDEV = 0x01
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_BENEATH = 0x08
RESOLVE_NO_SYMLINKS = 0x04
AT_EMPTY_PATH = 0x1000
STATX_BASIC_STATS = 0x07FF
STATX_BTIME = 0x0800

ELOOP = 40
EXDEV = 18
ENOENT = 2
EACCES = 13
EPERM = 1
ENOTDIR = 20
EISDIR = 21

CHUNK = 1024 * 1024
MAX_STDIN_LINE = 4 * 1024 * 1024

libc = ctypes.CDLL(None, use_errno=True)


class OpenHow(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("mode", ctypes.c_uint64),
        ("resolve", ctypes.c_uint64),
    ]


def openat2(dirfd, path_bytes, flags, resolve):
    how = OpenHow(flags, 0, resolve)
    fd = libc.syscall(
        SYS_OPENAT2,
        ctypes.c_int(dirfd),
        ctypes.c_char_p(path_bytes),
        ctypes.byref(how),
        ctypes.c_size_t(ctypes.sizeof(how)),
    )
    if fd < 0:
        return -1, ctypes.get_errno()
    return fd, 0


def statx_root(dirfd):
    """Return (ok, dict) with the identity of the directory object behind fd."""
    buf = ctypes.create_string_buffer(256)
    rc = libc.syscall(
        SYS_STATX,
        ctypes.c_int(dirfd),
        ctypes.c_char_p(b""),
        ctypes.c_int(AT_EMPTY_PATH),
        ctypes.c_uint(STATX_BASIC_STATS | STATX_BTIME),
        ctypes.byref(buf),
    )
    if rc != 0:
        return False, {"errno": ctypes.get_errno()}
    raw = buf.raw
    mask = struct.unpack_from("<I", raw, 0)[0]
    ino = struct.unpack_from("<Q", raw, 32)[0]
    btime_sec, btime_nsec = struct.unpack_from("<qI", raw, 80)
    dev_major, dev_minor = struct.unpack_from("<II", raw, 136)
    return True, {
        "devMajor": dev_major,
        "devMinor": dev_minor,
        "ino": ino,
        "btimeSec": btime_sec,
        "btimeNsec": btime_nsec,
        "btimeSupported": bool(mask & STATX_BTIME),
    }


ERRNO_CODES = {
    ELOOP: "symlink_rejected",
    EXDEV: "escapes_root_or_mount",
    ENOENT: "missing",
    ENOTDIR: "missing",
    EACCES: "denied",
    EPERM: "denied",
    EISDIR: "not_a_file",
}


def mtime_ms(info):
    # Derive from the integer in Python for BOTH read and walk. Converting ns
    # to a JS number first loses low bits (>2**53), causing double rounding.
    return info.st_mtime_ns / 1000000


def read_constrained(rootfd, rel_path, max_bytes):
    flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK
    resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
    fd, err = openat2(rootfd, os.fsencode(rel_path), flags, resolve)
    if fd < 0:
        return {"ok": False, "code": ERRNO_CODES.get(err, "open_failed"), "errno": err}
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            return {"ok": False, "code": "not_a_file"}
        if before.st_size > max_bytes:
            return {"ok": False, "code": "too_large", "size": before.st_size}
        chunks = []
        remaining = before.st_size
        while remaining > 0:
            chunk = os.read(fd, min(CHUNK, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        after = os.fstat(fd)
        if (
            after.st_size != before.st_size
            or after.st_mtime_ns != before.st_mtime_ns
            or after.st_ctime_ns != before.st_ctime_ns
            or after.st_ino != before.st_ino
        ):
            return {"ok": False, "code": "changed_during_read"}
        if len(content) != before.st_size:
            return {"ok": False, "code": "short_read"}
        return {
            "ok": True,
            "size": before.st_size,
            "mode": stat.S_IMODE(before.st_mode),
            "mtimeNs": before.st_mtime_ns,
            "mtimeMs": mtime_ms(before),
            "sha256": hashlib.sha256(content).hexdigest(),
            "content": content,
        }
    except OSError as exc:
        return {"ok": False, "code": ERRNO_CODES.get(exc.errno, "read_failed"), "errno": exc.errno}
    finally:
        os.close(fd)


def walk_constrained(rootfd, excluded):
    """Enumerate via directory fds. Never follow a symlink or cross a mount.

    Each recursive open is resolved against the pinned root, not a previously
    checked pathname. Failed enumeration is material loss, including at '.'.
    """
    entries = []
    gaps = []
    pending = ["."]
    resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
    while pending:
        rel = pending.pop()
        fd, err = openat2(rootfd, os.fsencode(rel), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC, resolve)
        if fd < 0:
            gaps.append({"path": rel, "reason": "directory_unreadable", "code": ERRNO_CODES.get(err, "open_failed")})
            continue
        try:
            try:
                names = sorted(os.listdir(fd))
            except OSError:
                gaps.append({"path": rel, "reason": "directory_unreadable"})
                continue
            for name in names:
                if len(entries) >= 100000:
                    return {"ok": False, "code": "enumeration_limit"}
                child = name if rel == "." else rel + "/" + name
                # .git itself is needed for classification but never traversed.
                if child != ".git" and any(child == prefix or child.startswith(prefix + "/") for prefix in excluded):
                    continue
                # The transport/path schema is UTF-8 and POSIX; do not silently
                # reinterpret unrepresentable names as another file.
                if "\\" in name or any(0xD800 <= ord(c) <= 0xDFFF for c in name):
                    gaps.append({"path": rel, "reason": "directory_unreadable", "code": "unsupported_filename"})
                    continue
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    mode = info.st_mode
                    kind = "dir" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) else "symlink" if stat.S_ISLNK(mode) else "other"
                    item = {"path": child, "type": kind, "mode": mode, "size": info.st_size, "mtimeMs": mtime_ms(info)}
                    if kind == "symlink":
                        item["linkTarget"] = os.readlink(name, dir_fd=fd)
                    entries.append(item)
                    # Git administrative data is read separately through the
                    # same constrained-read channel, never recursively copied.
                    if kind == "dir" and name != ".git":
                        pending.append(child)
                except OSError:
                    gaps.append({"path": child, "reason": "missing"})
        finally:
            os.close(fd)
    return {"ok": True, "entries": entries, "unreadableDirs": gaps}


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: capture_helper.py <rootfd>\n")
        return 2
    rootfd = int(sys.argv[1])
    # Verify the inherited fd is a directory we can constrain against.
    if not stat.S_ISDIR(os.fstat(rootfd).st_mode):
        sys.stderr.write("rootfd is not a directory\n")
        return 2
    stdin = sys.stdin
    stdout = sys.stdout
    raw_out = sys.stdout.buffer
    for line in stdin:
        if len(line) > MAX_STDIN_LINE:
            raw_out.write(b'{"ok":false,"code":"request_too_large"}\n')
            raw_out.flush()
            continue
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            raw_out.write(b'{"ok":false,"code":"bad_request"}\n')
            raw_out.flush()
            continue
        op = request.get("op")
        if op == "end":
            return 0
        if op == "statx_root":
            ok, info = statx_root(rootfd)
            payload = {"ok": ok, **info} if ok else {"ok": False, "code": "statx_failed", **info}
            raw_out.write(json.dumps(payload).encode("utf-8") + b"\n")
            raw_out.flush()
            continue
        if op == "walk":
            excluded = request.get("excluded", [])
            if not isinstance(excluded, list) or any(not isinstance(item, str) for item in excluded):
                raw_out.write(b'{"ok":false,"code":"bad_request"}\n')
                raw_out.flush()
                continue
            raw_out.write(json.dumps(walk_constrained(rootfd, excluded)).encode("utf-8") + b"\n")
            raw_out.flush()
            continue
        if op == "read":
            rel = str(request.get("path", "")).replace("\\", "/").lstrip("/")
            if not rel or rel.startswith("../") or rel == ".." or "\x00" in rel:
                raw_out.write(b'{"ok":false,"code":"bad_path"}\n')
                raw_out.flush()
                continue
            try:
                max_bytes = int(request.get("maxBytes", 64 * 1024 * 1024))
            except (TypeError, ValueError):
                max_bytes = 64 * 1024 * 1024
            result = read_constrained(rootfd, rel, max_bytes)
            if result.get("ok"):
                content = result.pop("content")
                raw_out.write(json.dumps(result).encode("utf-8") + b"\n")
                raw_out.write(content)
                raw_out.write(b"\n")
            else:
                raw_out.write(json.dumps(result).encode("utf-8") + b"\n")
            raw_out.flush()
            continue
        raw_out.write(b'{"ok":false,"code":"unknown_op"}\n')
        raw_out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
