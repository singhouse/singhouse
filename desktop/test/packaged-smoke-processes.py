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


def snapshot(lib):
    if c.sizeof(BSDInfo) != 136 or BSDInfo.seconds.offset != 120:
        raise RuntimeError("Unsupported macOS process-info ABI")
    count = lib.proc_listallpids(None, 0)
    if count <= 0 or count > 1_000_000:
        raise RuntimeError("Invalid macOS process count")
    for _ in range(3):
        capacity = count + 256
        buffer = (c.c_int * capacity)()
        count = lib.proc_listallpids(buffer, c.sizeof(buffer))
        if count <= 0 or count > 1_000_000:
            raise RuntimeError("Invalid macOS process enumeration")
        if count < capacity:
            break
    else:
        raise RuntimeError("macOS process enumeration remained truncated")
    rows, seen = [], set()
    for pid in buffer[:count]:
        if pid == 0:  # Kernel task, not an application process.
            continue
        if pid < 0 or pid in seen:
            raise RuntimeError("Invalid or duplicate macOS process identity")
        seen.add(pid)
        info = BSDInfo()
        c.set_errno(0)
        size = lib.proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info))
        if size == 0 and c.get_errno() == errno.ESRCH:
            continue  # Process exited between enumeration and inspection.
        if size != c.sizeof(info):
            raise RuntimeError(f"Cannot inspect macOS process {pid}: errno {c.get_errno()}")
        if info.pid != pid or info.parent == pid or not info.seconds or info.microseconds >= 1_000_000:
            raise RuntimeError("Malformed macOS process birth identity")
        rows.append({"pid": pid, "parent": info.parent,
                     "birth": str(info.seconds * 1_000_000 + info.microseconds)})
    if not rows:
        raise RuntimeError("Empty macOS process observation")
    return rows


def main():
    if sys.platform != "darwin":
        raise RuntimeError("macOS process observation requires Darwin")
    lib = c.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_listallpids.argtypes = [c.c_void_p, c.c_int]
    lib.proc_listallpids.restype = c.c_int
    lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
    lib.proc_pidinfo.restype = c.c_int
    rows = snapshot(lib)
    if not any(row["pid"] == os.getpid() and row["parent"] == os.getppid() for row in rows):
        raise RuntimeError("macOS process snapshot did not include its observer")
    print(json.dumps(rows, separators=(",", ":")))


if __name__ == "__main__":
    main()
