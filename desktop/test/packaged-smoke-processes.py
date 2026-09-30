# SPDX-License-Identifier: AGPL-3.0-only
"""Read-only macOS process identities for the packaged qualification harness.

ABI references (field layout and proc_pidinfo flavor):
https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h
No process can be signalled through this helper.
"""
import ctypes as c
import errno
import json
import os
import sys


class BSDInfo(c.Structure):
    _fields_ = ([(name, c.c_uint32) for name in (
        "flags", "status", "exit_status", "pid", "parent", "uid", "gid",
        "real_uid", "real_gid", "saved_uid", "saved_gid", "reserved")]
        + [("command", c.c_char * 16), ("name", c.c_char * 32)]
        + [(name, c.c_uint32) for name in ("files", "group", "job_count", "tty", "tty_group")]
        + [("nice", c.c_int32), ("seconds", c.c_uint64), ("microseconds", c.c_uint64)])


def list_pids(lib, uid):
    """Complete effective-UID enumeration. proc_listpids returns BYTES, not PIDs."""
    if type(uid) is not int or not 0 <= uid <= 0xFFFFFFFF:
        raise RuntimeError("Invalid macOS observer effective UID")
    width = c.sizeof(c.c_int)
    size = lib.proc_listpids(4, uid, None, 0)  # PROC_UID_ONLY
    for _ in range(3):
        if size <= 0 or size > 1_000_000 * width or size % width:
            raise RuntimeError("Invalid macOS process enumeration byte count")
        capacity = size // width + 256
        buffer = (c.c_int * capacity)()
        size = lib.proc_listpids(4, uid, buffer, c.sizeof(buffer))
        if size <= 0 or size > 1_000_000 * width or size % width:
            raise RuntimeError("Invalid macOS process enumeration byte count")
        if size < c.sizeof(buffer):
            break
    else:
        raise RuntimeError("macOS process enumeration remained truncated")
    pids, seen = [], set()
    for pid in buffer[:size // width]:
        if pid == 0:  # Unused kernel enumeration entries.
            continue
        if pid < 0 or pid in seen:
            raise RuntimeError("Invalid or duplicate macOS process identity")
        seen.add(pid)
        pids.append(pid)
    if not pids:
        raise RuntimeError("Empty macOS process enumeration")
    return pids


def snapshot(lib):
    if c.sizeof(BSDInfo) != 136 or BSDInfo.seconds.offset != 120:
        raise RuntimeError("Unsupported macOS process-info ABI")
    # Qualification observes only the test/app's effective-UID boundary. Normal
    # Electron/backend descendants must retain it; privileged descendants are
    # outside this harness's qualification scope.
    uid = os.geteuid()
    rows = []
    for pid in list_pids(lib, uid):
        info = BSDInfo()
        c.set_errno(0)
        size = lib.proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info))
        error = c.get_errno()
        if size == 0 and error == errno.ESRCH:
            continue  # Process exited between enumeration and inspection.
        if size != c.sizeof(info):
            raise RuntimeError(f"Cannot inspect macOS process {pid}: errno {error}")
        if info.uid != uid or os.geteuid() != uid:
            raise RuntimeError("macOS process effective UID changed")
        if info.pid != pid or info.parent == pid or not info.seconds or info.microseconds >= 1_000_000:
            raise RuntimeError("Malformed macOS process birth identity")
        rows.append({"pid": pid, "parent": info.parent,
                     "birth": str(info.seconds * 1_000_000 + info.microseconds)})
    if os.geteuid() != uid:
        raise RuntimeError("macOS observer effective UID changed")
    if not rows:
        raise RuntimeError("Empty macOS process observation")
    return rows


def main():
    if sys.platform != "darwin":
        raise RuntimeError("macOS process observation requires Darwin")
    lib = c.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_listpids.argtypes = [c.c_uint32, c.c_uint32, c.c_void_p, c.c_int]
    lib.proc_listpids.restype = c.c_int
    lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
    lib.proc_pidinfo.restype = c.c_int
    rows = snapshot(lib)
    if not any(row["pid"] == os.getpid() and row["parent"] == os.getppid() for row in rows):
        raise RuntimeError("macOS process snapshot did not include its observer")
    if not any(row["pid"] == os.getppid() for row in rows):
        raise RuntimeError("macOS harness parent is outside observer effective UID")
    print(json.dumps(rows, separators=(",", ":")))


if __name__ == "__main__":
    main()
