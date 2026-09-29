# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded one-line private bootstrap input, before parent-lifeline monitoring."""

import json
import math
import os
import threading

_ERROR = "Private bootstrap configuration could not be read."


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("non-JSON constant")


def read_private_config(fd, timeout=5, max_bytes=16384):
    """Read exactly one UTF-8 JSON line and return its ``modal`` object or None.

    ``max_bytes`` includes the terminating newline. Never buffers beyond that
    newline, leaving subsequent bytes for the caller's lifeline monitor. The
    descriptor remains caller-owned. A timeout leaves a daemon reader blocked:
    the caller must exit, and must not reuse the descriptor after this failure.
    The envelope schema is validated here; modal configuration policy belongs
    to the caller, before any credentials are used.
    """
    if (type(fd) is not int or fd < 0
            or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0
            or type(max_bytes) is not int or max_bytes < 1):
        raise RuntimeError(_ERROR)

    finished = threading.Event()
    result = []

    def read_line():
        try:
            line = bytearray()
            while len(line) < max_bytes:
                chunk = os.read(fd, 1)
                if not chunk:
                    return
                line.extend(chunk)
                if chunk == b"\n":
                    result.append(bytes(line))
                    return
        except Exception:
            # Neither OS diagnostics nor private input may reach logs/errors.
            pass
        finally:
            finished.set()

    try:
        threading.Thread(target=read_line, daemon=True).start()
        if not finished.wait(timeout) or not result:
            raise ValueError("missing complete line")
        envelope = json.loads(result[0].decode("utf-8"), object_pairs_hook=_unique_object,
                              parse_constant=_reject_constant)
        if (not isinstance(envelope, dict) or set(envelope) != {"schema", "modal"}
                or type(envelope["schema"]) is not int or envelope["schema"] != 1
                or (envelope["modal"] is not None and not isinstance(envelope["modal"], dict))):
            raise ValueError("invalid envelope")
        return envelope["modal"]
    except Exception:
        raise RuntimeError(_ERROR) from None
