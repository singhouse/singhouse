# SPDX-License-Identifier: AGPL-3.0-only
"""In-memory rate limiting for sensitive endpoints.

A full-blown `slowapi`/`limits` setup doesn't pay for itself at this scale and
its function-decorator wrapping confuses FastAPI's body parameter introspection
(unprovokable 422s on POST routes), so this module rolls its own.

Two independent sets of controls live here, for two different problems:

* ``_SlidingWindow`` backs ``login_limiter`` and ``gate_limiter`` — a fixed
  budget per window per address, against human-chosen secrets where the point
  is to make online guessing tedious.
* ``_BackoffBucket`` + ``_GlobalPenalty`` back the join credential, which is
  machine-generated from a bounded keyspace. The block comment above them
  explains why that changes the shape.

All state is per-process, so every threshold here is per-process too. A
deployment running more than one worker should size them accordingly.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import time
from collections import defaultdict, deque
from typing import Callable, Deque, Dict

from fastapi import HTTPException, Request, status


class _SlidingWindow:
    def __init__(self, max_attempts: int, window_seconds: float, name: str) -> None:
        self.max_attempts = max_attempts
        self.window = window_seconds
        self.name = name
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, request: Request) -> None:
        ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        cutoff = now - self.window
        hits = self._hits[ip]

        while hits and hits[0] < cutoff:
            hits.popleft()

        if len(hits) >= self.max_attempts:
            retry = int(self.window - (now - hits[0]))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"too many {self.name} attempts; retry in {retry}s",
                headers={"Retry-After": str(max(retry, 1))},
            )
        hits.append(now)


_login_window = _SlidingWindow(
    max_attempts=int(os.getenv("LOGIN_RATE_MAX", "5")),
    window_seconds=float(os.getenv("LOGIN_RATE_WINDOW", "60")),
    name="login",
)


def login_limiter(request: Request) -> None:
    """FastAPI dependency: 5 login attempts per minute per source IP (defaults)."""
    _login_window.check(request)


# The single-host gate is a single brute-forceable shared password, so it needs
# throttling more than email+password login does. Its own window keeps core's
# gate limit independent of premium's login limit.
_gate_window = _SlidingWindow(
    max_attempts=int(os.getenv("GATE_RATE_MAX", "5")),
    window_seconds=float(os.getenv("GATE_RATE_WINDOW", "60")),
    name="gate",
)


def gate_limiter(request: Request) -> None:
    """FastAPI dependency: 5 gate-unlock attempts per minute per source IP."""
    _gate_window.check(request)


# ---------------------------------------------------------------------------
# Join-credential throttling
# ---------------------------------------------------------------------------
#
# Guessing a join credential is a different attack from guessing a password,
# and the sliding windows above are the wrong shape for it. A window grants a
# fixed budget forever, so anyone pacing themselves to it gets unlimited
# attempts at a steady rate — against a bounded keyspace that is only a slower
# certainty.
#
# Two properties do the work here, and both were arrived at by getting them
# wrong first:
#
#   * **Key on the network, not the address.** Per-address accounting is
#     per-attempt accounting: an end site's IPv6 allocation holds more
#     addresses than anyone can exhaust, so a ledger keyed that way is free to
#     walk away from. /24 and /64 are roughly the smallest units that have to
#     be acquired rather than minted.
#   * **No control may deny a correct credential.** Anything that can is an
#     outage of the whole guest surface, and one the identical-response rule
#     then guarantees nobody can diagnose. The process-wide control therefore
#     expresses itself as a delay, which lets it apply to every caller
#     unconditionally — including callers that cannot be attributed at all.
#
# A corollary worth stating because its absence caused a real hole: success is
# never a *credit*. Nothing a caller can do on purpose reduces their own
# penalty; only elapsed time does.
#
# Success IS a charge, though (ruled 2026-07-29): each successful admission
# counts 1× against a parallel ledger of the same shape (`_join_success`).
# A valid code is a semi-public secret, so "holds one" is the assumed attacker
# position — and an unmetered success path lets that holder mint tokens at
# request speed, churning the device table until real phones get evicted. The
# ledger is parallel rather than shared because the two inputs have opposite
# honest baselines: a LAN show puts every phone in the room on one /24, so a
# room's worth of *successes* is normal and must never trip the allowance
# sized for *failures*. The success allowance is sized to the device cap —
# the table can fill entirely before the first lock is possible.


class RateLimited(Exception):
    """Raised instead of ``HTTPException`` so the caller chooses the response.

    A join endpoint should answer identically whether a credential was unknown,
    expired, revoked, malformed, or refused — a distinguishable throttle
    response is itself a signal. Keeping this exception free of any opinion
    about status codes is what lets a route collapse every failure into one
    answer.

    Identical bodies are necessary and not sufficient: responses also have to
    take the same time, which only the route can arrange.
    """

    def __init__(self) -> None:
        # No payload. An exception whose repr varies by caller leaks the source
        # into any generic handler or log line.
        super().__init__()


def _network_key(request: Request) -> str | None:
    """Collapse a client address to the network that owns it.

    Returns ``None`` when the transport supplied no client — a Unix-socket
    deployment does this for every request. Such a caller cannot be attributed,
    so per-source accounting is skipped for them; the process-wide control is
    unconditional and still covers them.

    This is only as good as the address the server was handed. uvicorn's
    proxy-header handling takes the first *untrusted* hop, which a client
    cannot forge — but ``FORWARDED_ALLOW_IPS=*`` makes it take the leftmost,
    entirely client-supplied entry instead, at which point a caller mints a
    fresh network per request for the price of a header. See the warning
    emitted below.
    """
    client = getattr(request, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    if not host:
        return None
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        # Not an address (odd transports, test doubles). Key it verbatim.
        return host
    # An IPv4-mapped address (``::ffff:a.b.c.d``, which a dual-stack socket
    # reports for every IPv4 peer) is an IPv4 client in a v6 costume. Sending
    # it down the /64 branch would file the entire IPv4 internet under one
    # ``::/64`` ledger — a shared bucket on the control that can deny.
    addr = getattr(addr, "ipv4_mapped", None) or addr
    prefix = 24 if addr.version == 4 else 64
    return str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))


class _BackoffBucket:
    """Per-network consecutive-failure tracker with growing lockouts.

    Failures escalate; only elapsed time forgives. There is deliberately no
    success path — a credential holder must not be able to spend a success to
    clear their own ledger, and where credentials are long-lived that would
    mean everyone ever handed one. (The instance named ``_join_success`` does
    not contradict this: it *charges* successes into its own ledger via this
    same method; nothing reduces any instance's state but time.)

    Note the NAT tradeoff this shape accepts: a venue behind one address is one
    key, so a roomful of people fumbling a code share an allowance — and over
    LAN, every phone in the room shares one /24 outright. The free allowance
    must be sized against the honest baseline of whatever the instance counts:
    for failures that is "people fumbling a code" (guests who scan the QR never
    type anything and never appear in that ledger); for successes it is the
    whole room joining, which is why `_join_success` gets its own instance
    with a device-cap-sized allowance rather than sharing this one.
    """

    # Overflow guard: without it, base * 2**over on a large counter builds a
    # bignum and raises converting to float — an unhandled 500, which is also
    # the one response distinguishable from the generic failure.
    _EXPONENT_CAP = 32  # base * 2**32 already dwarfs any sane max_lock
    _EVICT_TO = 0.875  # batch down to this fraction, so eviction amortizes

    def __init__(
        self,
        free_attempts: int,
        base_seconds: float,
        max_lock_seconds: float,
        decay_seconds: float,
        max_keys: int = 4096,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.free_attempts = free_attempts
        self.base = base_seconds
        self.max_lock = max_lock_seconds
        self.decay = decay_seconds
        self.max_keys = max_keys
        # Injectable so tests can advance time deterministically; patching
        # time.monotonic globally would also move the event loop's clock.
        self._clock = clock
        # key -> (failures, locked_until, last_failure, last_seen)
        self._state: Dict[str, tuple[int, float, float, float]] = {}

    @property
    def _failure_cap(self) -> int:
        """Ceiling on the stored counter.

        Not the overflow guard — ``_EXPONENT_CAP`` already covers that, and the
        two are redundant on purpose. This one bounds worst-case *forgiveness*:
        decay removes one step per period, so an uncapped counter driven into
        the thousands would keep a network locked for weeks. Behind NAT that
        network is an entire venue.
        """
        return self.free_attempts + self._EXPONENT_CAP + 1

    def _effective_failures(self, entry: tuple, now: float) -> int:
        """Stored count less one step per elapsed decay period."""
        failures, _, last_failure, _ = entry
        if self.decay <= 0:
            return failures
        steps = int((now - last_failure) // self.decay)
        return max(0, failures - steps) if steps > 0 else failures

    def _evict(self, now: float) -> None:
        """Bound the table, in batches so the cost amortizes to O(1).

        Evicting one key per insert once full means a full scan and sort on
        every failure — measured at three orders of magnitude slower, on
        synchronous calls made from an async route that also serves media.
        """
        if len(self._state) <= self.max_keys:
            return

        horizon = now - self.max_lock * 2
        self._state = {k: v for k, v in self._state.items() if v[3] > horizon}

        target = int(self.max_keys * self._EVICT_TO)
        if len(self._state) <= target:
            return
        # Shed fewest-failures first, then least-recently-seen, so a flood of
        # throwaway keys can only ever displace other throwaway keys.
        ordered = sorted(self._state.items(), key=lambda kv: (kv[1][0], kv[1][3]))
        for key, _ in ordered[: len(self._state) - target]:
            del self._state[key]

    def check(self, request: Request) -> None:
        """Raise ``RateLimited`` while this network is locked out."""
        key = _network_key(request)
        if key is None:
            return
        entry = self._state.get(key)
        if entry is None:
            return
        now = self._clock()
        if entry[1] > now:
            # Refresh last_seen so a network that keeps hammering while denied
            # cannot age out of the table and lose its accumulated penalty.
            self._state[key] = (entry[0], entry[1], entry[2], now)
            raise RateLimited()

    def record_failure(self, request: Request) -> None:
        now = self._clock()
        self._evict(now)
        key = _network_key(request)
        if key is None:
            return
        entry = self._state.get(key)
        prior = self._effective_failures(entry, now) if entry is not None else 0
        failures = min(prior + 1, self._failure_cap)
        over = failures - self.free_attempts
        if over <= 0:
            locked_until = 0.0
        else:
            exponent = min(over - 1, self._EXPONENT_CAP)
            locked_until = now + min(self.base * (2**exponent), self.max_lock)
        if entry is not None:
            # Never let a recomputation shorten a penalty already in force.
            # Decay can lower the effective count mid-lockout, and a failure
            # arriving right then would otherwise be rewarded for it.
            locked_until = max(locked_until, entry[1])
        self._state[key] = (failures, locked_until, now, now)

    def reset(self) -> None:
        self._state.clear()


class _WindowedCounter:
    """Count over a rolling window in coarse buckets.

    Bucketing keeps memory bounded by ``window / bucket`` regardless of rate,
    so the magnitude of a burst stays reportable — a plain bounded deque of
    timestamps has to either grow without limit or lie about how big the burst
    was, and that magnitude is the only thing distinguishing an attack from a
    roomful of people fumbling a code.
    """

    def __init__(
        self,
        window_seconds: float,
        bucket_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.window = window_seconds
        self.bucket = bucket_seconds
        self._clock = clock
        self._buckets: Deque[list] = deque()

    def _trim(self, now: float) -> None:
        cutoff = now - self.window
        while self._buckets and self._buckets[0][0] < cutoff:
            self._buckets.popleft()

    def add(self, n: int = 1) -> None:
        now = self._clock()
        self._trim(now)
        stamp = now - (now % self.bucket)
        if self._buckets and self._buckets[-1][0] == stamp:
            self._buckets[-1][1] += n
        else:
            self._buckets.append([stamp, n])

    def value(self) -> int:
        self._trim(self._clock())
        return sum(count for _, count in self._buckets)

    def reset(self) -> None:
        self._buckets.clear()


class _GlobalPenalty:
    """Process-wide failure pressure, expressed as a delay.

    This is the control that sees breadth: many networks trying a few values
    each trip no per-network rule anywhere. It deliberately never denies. A
    denial would turn a modest stream of wrong codes into an outage for guests
    presenting correct ones, so making it a delay is what allows it to apply to
    every caller unconditionally — which is the only version that cannot be
    walked around.
    """

    def __init__(
        self,
        free_failures: int,
        window_seconds: float,
        step_seconds: float,
        max_delay_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.free_failures = free_failures
        self.step = step_seconds
        self.max_delay = max_delay_seconds
        # Bucket derived from the window, not fixed: a hardcoded bucket larger
        # than a (tunable) window silently zeroes the control, because the
        # current bucket's floored stamp is already older than the cutoff.
        self._counter = _WindowedCounter(
            window_seconds, max(1.0, window_seconds / 60), clock
        )

    def record_failure(self) -> None:
        self._counter.add()

    def delay(self) -> float:
        """Seconds every join attempt must wait before being processed."""
        over = self._counter.value() - self.free_failures
        if over <= 0:
            return 0.0
        return float(min(self.step * over, self.max_delay))

    @property
    def recent_failures(self) -> int:
        return self._counter.value()

    def reset(self) -> None:
        self._counter.reset()


_join_backoff = _BackoffBucket(
    free_attempts=int(os.getenv("JOIN_RATE_FREE", "10")),
    base_seconds=float(os.getenv("JOIN_RATE_BASE", "2")),
    max_lock_seconds=float(os.getenv("JOIN_RATE_MAX_LOCK", "900")),
    decay_seconds=float(os.getenv("JOIN_RATE_DECAY", "300")),
)

# Successful admissions, charged 1× each (ruling, 2026-07-29). Same mechanics
# as the failure ledger — escalation, decay, no way to spend anything down —
# but its own instance with its own allowance, because an honest room's
# successes land on ONE network key over LAN and must never compete with the
# failure allowance.
#
# Sizing: the default allowance matches the default per-host device cap
# (DEFAULT_MAX_DEVICES, 250, in premium's join storage), so a single host's
# room can fill its whole token table without a single lock, while a churner
# who blows past the cap hits exponential lockouts before eviction does real
# damage. Two caveats the pairing does NOT cover, deliberately accepted:
#   * this ledger is keyed per NETWORK with no host dimension (it is checked
#     in `join_guard`, before any storage lookup, where no host is known
#     yet) — several hosts serving one network share the allowance, so a
#     multi-host box behind one /24 should raise JOIN_SUCCESS_FREE;
#   * the two knobs bind at different times (this one at import, the device
#     cap lazily) — raise KARAOKE_GUEST_MAX_DEVICES past 250 and you must
#     raise JOIN_SUCCESS_FREE with it, and a restart is what applies it.
#
# Decay is deliberately fast (60s): a room that legitimately re-scans after a
# code rotation re-earns its allowance in minutes, not hours.
_join_success = _BackoffBucket(
    free_attempts=int(os.getenv("JOIN_SUCCESS_FREE", "250")),
    base_seconds=float(os.getenv("JOIN_SUCCESS_BASE", "2")),
    max_lock_seconds=float(os.getenv("JOIN_SUCCESS_MAX_LOCK", "900")),
    decay_seconds=float(os.getenv("JOIN_SUCCESS_DECAY", "60")),
)

_join_global = _GlobalPenalty(
    free_failures=int(os.getenv("JOIN_GLOBAL_FREE", "200")),
    window_seconds=float(os.getenv("JOIN_GLOBAL_WINDOW", "600")),
    step_seconds=float(os.getenv("JOIN_GLOBAL_STEP", "0.05")),
    max_delay_seconds=float(os.getenv("JOIN_GLOBAL_MAX_DELAY", "5")),
)


if os.getenv("FORWARDED_ALLOW_IPS", "").strip() == "*":
    logging.getLogger(__name__).warning(
        "FORWARDED_ALLOW_IPS=* — the client address is read from a header the "
        "client controls, so per-network throttling can be sidestepped by "
        "varying it. Set it to the proxy's own address."
    )


def join_guard(request: Request) -> None:
    """Raise ``RateLimited`` if this caller's network is locked out.

    Call before any storage lookup, so malformed input costs the same as a
    well-formed guess and validation does not become a free probe.

    Checks both ledgers: a network locked for failures and one locked for
    success churn are refused identically, because the route answers every
    refusal identically anyway.
    """
    _join_backoff.check(request)
    _join_success.check(request)


def join_delay() -> float:
    """Seconds the caller must be held before their attempt is processed.

    Zero under normal load. The route is responsible for awaiting it, and for
    applying the same floor to every outcome so the wait is not itself a tell.

    Await it *before* acquiring a database session. Sleeping for seconds while
    holding one would make the connection pool, not the delay, the thing that
    fails first under pressure.
    """
    return _join_global.delay()


def join_record_failure(request: Request) -> None:
    """Charge one failed attempt against the failure ledger and the process."""
    _join_backoff.record_failure(request)
    _join_global.record_failure()


# Seconds between success-lock warnings. Same shape (and same None-not-0.0
# sentinel reasoning) as the breach log in premium's join routes: the
# condition persists, and one line per refused join would bury the signal.
_SUCCESS_LOCK_LOG_INTERVAL = 60.0
_last_success_lock_log: float | None = None


def join_record_success(request: Request) -> None:
    """Charge one successful admission against the success ledger (1×).

    Deliberately NOT fed to the process-wide control: `_join_global` exists to
    see distributed *guessing*, and successes would let one busy room raise the
    delay applied to every other honest guest. The success ledger is the same
    bucket mechanics as the failure one — `record_failure` here means "record
    one charged attempt", not that anything failed.

    When the charge engages a lock, that is WARNED, and the warning is the
    only signal there is: a success-locked network gets the same generic
    refusal as everything else, this ledger never feeds the global-pressure
    log, and the device-cap warning goes quiet the moment joins stop reaching
    storage. Without this line, a venue that churned itself into a lock is a
    dead QR with no explanation anywhere.
    """
    global _last_success_lock_log
    _join_success.record_failure(request)
    key = _network_key(request)
    if key is None:
        return
    entry = _join_success._state.get(key)
    if entry is None or entry[1] <= _join_success._clock():
        return
    now = time.monotonic()
    if (
        _last_success_lock_log is not None
        and now - _last_success_lock_log < _SUCCESS_LOCK_LOG_INTERVAL
    ):
        return
    _last_success_lock_log = now
    logging.getLogger(__name__).warning(
        "join: network %s exceeded the successful-admission allowance and is "
        "now refused with the generic answer — this is success churn (one "
        "code-holder minting tokens), not guessing. If it is your own room, "
        "raise JOIN_SUCCESS_FREE; if not, rotate the code.",
        key,
    )


def join_recent_failures() -> int:
    """Failures across the process in the recent window, for logging."""
    return _join_global.recent_failures


def _reset_join_limiter_for_tests() -> None:
    """Clear all three controls. Named to be unattractive as an import."""
    global _last_success_lock_log
    _join_backoff.reset()
    _join_success.reset()
    _join_global.reset()
    _last_success_lock_log = None
