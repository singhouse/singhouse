# SPDX-License-Identifier: AGPL-3.0-only
"""Guest join-credential seam: the backend hook and the throttling.

Core is single-tenant and issues no join credential, so the backend-facing
tests here assert that it contributes nothing rather than something.

The throttling tests carry most of the weight, and several exist specifically
to pin ways a caller could otherwise wipe their own penalty — each of those
corresponds to a hole an earlier draft actually had.
"""

from types import SimpleNamespace

import pytest

from karaoke_backend import ratelimit
from karaoke_backend.api.gate import SingleHostBackend
from karaoke_backend.api.identity import (
    get_auth_backend,
    join_credential_for,
    set_auth_backend,
)


def _req(ip: str = "10.0.0.1"):
    """Minimal stand-in for the one attribute the limiter reads."""
    return SimpleNamespace(client=SimpleNamespace(host=ip))


class _Clock:
    """Manually advanced monotonic clock."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def _bucket(clock, free=3, base=2, max_lock=900, decay=0, max_keys=4096):
    return ratelimit._BackoffBucket(
        free_attempts=free,
        base_seconds=base,
        max_lock_seconds=max_lock,
        decay_seconds=decay,
        max_keys=max_keys,
        clock=clock,
    )


# ---------------------------------------------------------------------------
# join_credential_for
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_single_host_backend_has_no_join_credential():
    assert await SingleHostBackend().join_credential(None, 1) is None


@pytest.mark.asyncio
async def test_join_credential_for_tolerates_a_backend_without_the_hook():
    """A backend written before this hook must not break the QR route."""

    class _Old:
        pass

    original = get_auth_backend()
    try:
        set_auth_backend(_Old())
        assert await join_credential_for(None, 1) is None
    finally:
        set_auth_backend(original)


@pytest.mark.asyncio
async def test_join_credential_for_returns_the_backends_value():
    class _WithCode:
        async def join_credential(self, db, host_id):
            return f"CODE{host_id}"

    original = get_auth_backend()
    try:
        set_auth_backend(_WithCode())
        assert await join_credential_for(None, 4) == "CODE4"
    finally:
        set_auth_backend(original)


@pytest.mark.asyncio
async def test_join_credential_for_does_not_swallow_backend_errors():
    """Degrading silently here would emit a join URL with no credential."""

    class _Broken:
        async def join_credential(self, db, host_id):
            raise RuntimeError("boom")

    original = get_auth_backend()
    try:
        set_auth_backend(_Broken())
        with pytest.raises(RuntimeError, match="boom"):
            await join_credential_for(None, 1)
    finally:
        set_auth_backend(original)


# ---------------------------------------------------------------------------
# Source keying
# ---------------------------------------------------------------------------


def test_addresses_in_one_network_share_a_ledger():
    """Per-address accounting is per-attempt accounting.

    An end site's IPv6 allocation holds more addresses than any ledger can
    outlast, so keying on the exact address means the ledger can be walked
    away from for free.
    """
    v4_a = ratelimit._network_key(_req("203.0.113.7"))
    v4_b = ratelimit._network_key(_req("203.0.113.200"))
    assert v4_a == v4_b == "203.0.113.0/24"

    v6_a = ratelimit._network_key(_req("2001:db8:1:2::1"))
    v6_b = ratelimit._network_key(_req("2001:db8:1:2:ffff:ffff:ffff:ffff"))
    assert v6_a == v6_b == "2001:db8:1:2::/64"


def test_ipv4_mapped_addresses_key_as_ipv4():
    """A dual-stack socket reports every IPv4 peer as ``::ffff:a.b.c.d``.

    Taking the /64 branch for those would file the entire IPv4 internet under
    one ``::/64`` ledger — a shared bucket on the control that can deny, which
    is the self-DoS this design removes everywhere else.
    """
    assert ratelimit._network_key(_req("::ffff:203.0.113.7")) == "203.0.113.0/24"
    assert ratelimit._network_key(_req("::ffff:198.51.100.9")) == "198.51.100.0/24"
    assert ratelimit._network_key(_req("::ffff:203.0.113.7")) != ratelimit._network_key(
        _req("::ffff:198.51.100.9")
    )


def test_separate_networks_do_not_share_a_ledger():
    assert ratelimit._network_key(_req("203.0.113.7")) != ratelimit._network_key(
        _req("198.51.100.7")
    )


def test_missing_client_yields_no_source_key():
    assert ratelimit._network_key(SimpleNamespace(client=None)) is None


def test_non_address_client_is_keyed_verbatim():
    assert ratelimit._network_key(_req("not-an-ip")) == "not-an-ip"


# ---------------------------------------------------------------------------
# Per-network exponential backoff
# ---------------------------------------------------------------------------


def test_free_attempts_do_not_lock_out():
    b = _bucket(_Clock(), free=3)
    for _ in range(3):
        b.check(_req())
        b.record_failure(_req())
    b.check(_req())  # still inside the free allowance


def test_failure_past_the_allowance_locks_out():
    b = _bucket(_Clock(), free=3)
    for _ in range(4):
        b.record_failure(_req())
    with pytest.raises(ratelimit.RateLimited):
        b.check(_req())


def test_lockout_grows_exponentially_and_then_expires():
    clock = _Clock()
    b = _bucket(clock, free=1, base=2)

    b.record_failure(_req())  # free
    b.record_failure(_req())  # 1st over -> 2s
    clock.advance(1)
    with pytest.raises(ratelimit.RateLimited):
        b.check(_req())
    clock.advance(2)
    b.check(_req())  # elapsed

    b.record_failure(_req())  # 2nd over -> 4s, not another 2s
    clock.advance(3)
    with pytest.raises(ratelimit.RateLimited):
        b.check(_req())
    clock.advance(2)
    b.check(_req())


def test_lockout_is_capped():
    clock = _Clock()
    b = _bucket(clock, free=0, base=2, max_lock=10)
    for _ in range(20):
        b.record_failure(_req())
    clock.advance(11)
    b.check(_req())  # capped at 10s, not 2**20


def test_sustained_failures_do_not_overflow_the_exponent():
    """``base * 2**over`` on an unbounded counter raises OverflowError.

    The result would be an unhandled 500 — also the one response an attacker
    could tell apart from the generic failure everything else returns.
    """
    clock = _Clock()
    b = _bucket(clock, free=3)
    for _ in range(2000):
        b.record_failure(_req())
    assert b._state["10.0.0.0/24"][0] <= b._failure_cap
    clock.advance(901)
    b.check(_req())


def test_there_is_no_success_path_to_clear_a_penalty(join_limiter):
    """Success must never be a *credit*.

    Join codes are long-lived, so a credential holder who could spend a success
    to clear their ledger would be able to guess indefinitely — and "holds a
    valid code" includes everyone ever handed one, for any host.

    This used to also assert ``join_record_success`` did not exist. The
    2026-07-29 ruling added it — but as a *charge* against a parallel ledger,
    which is the opposite of what this test forbids. The class-level pin
    stands: no bucket has a success method that touches its own state.
    """
    assert not hasattr(ratelimit._BackoffBucket, "record_success")

    # And behaviorally: successes recorded against a locked-for-failures
    # network do not shorten its lockout by a single second.
    r = _req("203.0.113.77")
    for _ in range(50):
        ratelimit.join_record_failure(r)
    with pytest.raises(ratelimit.RateLimited):
        ratelimit.join_guard(r)
    for _ in range(50):
        ratelimit.join_record_success(r)
    with pytest.raises(ratelimit.RateLimited):
        ratelimit.join_guard(r)


def test_only_elapsed_time_forgives():
    clock = _Clock()
    b = _bucket(clock, free=1, base=2, decay=300)
    for _ in range(4):
        b.record_failure(_req())
    assert b._state["10.0.0.0/24"][0] == 4

    clock.advance(900)  # three decay periods
    b.record_failure(_req())
    assert b._state["10.0.0.0/24"][0] == 2  # 4 - 3, then +1


def test_decay_cannot_drive_the_counter_below_zero():
    clock = _Clock()
    b = _bucket(clock, free=1, base=2, decay=10)
    b.record_failure(_req())
    clock.advance(10_000)
    b.record_failure(_req())
    assert b._state["10.0.0.0/24"][0] == 1


def test_hammering_while_denied_does_not_age_a_network_out():
    """A denied caller must not be able to outlast its own penalty.

    Eviction takes idle time into account, so if a rejected check left the
    record untouched, the more requests a locked-out network sent the sooner it
    would be forgiven.
    """
    clock = _Clock()
    b = _bucket(clock, free=0, base=60, max_lock=60, max_keys=4)
    b.record_failure(_req("203.0.113.1"))
    seen_before = b._state["203.0.113.0/24"][3]

    clock.advance(30)
    for _ in range(10):
        with pytest.raises(ratelimit.RateLimited):
            b.check(_req("203.0.113.1"))
    assert b._state["203.0.113.0/24"][3] > seen_before


def test_denied_checks_keep_the_table_slot_without_delaying_decay():
    """The two timestamps exist for opposite reasons and must stay separate.

    ``last_seen`` keeps a hammering network from aging out of the table;
    ``last_failure`` is what decay measures from. If the deny-path refresh
    touched ``last_failure`` too, a locked-out caller could hold their own
    penalty open indefinitely just by continuing to knock.
    """
    clock = _Clock()
    b = _bucket(clock, free=10, base=2, max_lock=900, decay=300)
    for _ in range(25):  # 15 over -> capped 900s lock
        b.record_failure(_req("203.0.113.1"))
    key = "203.0.113.0/24"
    assert b._state[key][0] == 25

    for _ in range(120):  # knock every 30s for an hour while locked
        clock.advance(30)
        try:
            b.check(_req("203.0.113.1"))
        except ratelimit.RateLimited:
            pass

    # 3600s elapsed / 300s per step = 12 steps forgiven, regardless of knocking.
    assert b._effective_failures(b._state[key], clock.t) == 13


def test_a_late_failure_cannot_shorten_a_live_lockout():
    clock = _Clock()
    b = _bucket(clock, free=0, base=60, max_lock=900, decay=30)
    for _ in range(5):  # escalate to the 900s ceiling
        b.record_failure(_req("203.0.113.1"))
    key = "203.0.113.0/24"
    locked_until = b._state[key][1]
    assert locked_until == clock.t + 900

    # Deep into the lockout, decay has driven the effective count to zero, so a
    # fresh computation would produce a *shorter* deadline than the one still
    # running — rewarding the caller for having waited it out partway.
    clock.advance(720)
    b.record_failure(_req("203.0.113.1"))
    assert b._state[key][1] >= locked_until


def test_flooding_the_table_cannot_launder_an_accumulated_penalty():
    """Throwaway keys are cheap to mint; they must not buy a clean slate."""
    clock = _Clock()
    b = _bucket(clock, free=0, base=2, max_lock=8, max_keys=8)
    for _ in range(5):
        b.record_failure(_req("203.0.113.1"))
    assert b._state["203.0.113.0/24"][0] == 5
    clock.advance(9)  # its lockout elapses; the counter must not

    for i in range(60):
        b.record_failure(_req(f"198.51.{i}.1"))

    assert len(b._state) <= b.max_keys + 1
    b.record_failure(_req("203.0.113.1"))
    assert b._state["203.0.113.0/24"][0] == 6  # escalated, not reset


def test_eviction_is_batched_not_one_per_insert():
    """One eviction per insert means a full scan and sort on every failure.

    These calls are synchronous and made from an async route that also serves
    media, so the cost lands on the event loop.
    """
    clock = _Clock()
    b = _bucket(clock, free=0, max_keys=16)
    for i in range(18):
        b.record_failure(_req(f"198.51.{i}.1"))
    # One-per-insert eviction would leave the table sitting at the cap. A batch
    # down to _EVICT_TO leaves it well below, which is what amortizes the cost.
    assert len(b._state) == int(16 * b._EVICT_TO) + 1


def test_idle_networks_are_evicted_even_when_heavily_penalized():
    """The idleness pass has to do real work, not just agree with the sort.

    The idle keys here carry the *highest* counters, so the fewest-failures
    pass would preserve them. Only eviction by idle time removes them.
    """
    clock = _Clock()
    b = _bucket(clock, free=0, base=2, max_lock=8, max_keys=4)
    for i in range(4):
        for _ in range(9):  # deep counters
            b.record_failure(_req(f"198.51.{i}.1"))
    clock.advance(1000)  # far past max_lock * 2

    for i in range(5):  # fresh, shallow keys
        b.record_failure(_req(f"203.0.{i}.1"))
    assert all(k.startswith("203.0.") for k in b._state)


def test_a_short_window_does_not_silently_disable_the_global_control():
    """A bucket wider than the window drops every failure as already expired."""
    clock = _Clock()
    clock.advance(5)  # land off a bucket boundary
    g = ratelimit._GlobalPenalty(1, 1, 0.5, 5, clock=clock)
    for _ in range(100):
        g.record_failure()
    assert g.recent_failures == 100
    assert g.delay() > 0


def test_unattributable_callers_are_not_tracked_per_source():
    """A shared bucket for clientless requests would be a self-DoS.

    Every such request would climb one ladder, so a handful of them would lock
    out every other clientless caller. Breadth is caught process-wide instead.
    """
    b = _bucket(_Clock(), free=0)
    anon = SimpleNamespace(client=None)
    for _ in range(10):
        b.record_failure(anon)
    b.check(anon)
    assert b._state == {}


# ---------------------------------------------------------------------------
# Process-wide pressure, expressed as delay
# ---------------------------------------------------------------------------


def test_no_delay_under_normal_load():
    g = ratelimit._GlobalPenalty(10, 600, 0.05, 5, clock=_Clock())
    for _ in range(10):
        g.record_failure()
    assert g.delay() == 0.0


def test_delay_grows_with_pressure_and_is_capped():
    g = ratelimit._GlobalPenalty(10, 600, 0.5, 2, clock=_Clock())
    for _ in range(14):
        g.record_failure()
    assert g.delay() == pytest.approx(2.0)  # 4 over * 0.5, capped at 2

    for _ in range(1000):
        g.record_failure()
    assert g.delay() == 2.0  # still capped


def test_global_control_never_denies():
    """It must not be able to turn away a correct credential.

    A denial would make a modest stream of wrong codes an outage for guests
    presenting right ones, which the identical-response rule then guarantees
    nobody could diagnose. Delay is what lets it apply to everyone.
    """
    g = ratelimit._GlobalPenalty(1, 600, 0.05, 5, clock=_Clock())
    for _ in range(10_000):
        g.record_failure()
    assert isinstance(g.delay(), float)  # a number, never an exception
    assert not hasattr(g, "check")


def test_pressure_decays_out_of_the_window():
    clock = _Clock()
    g = ratelimit._GlobalPenalty(1, 600, 0.05, 5, clock=clock)
    for _ in range(50):
        g.record_failure()
    assert g.delay() > 0
    clock.advance(601)
    assert g.delay() == 0.0
    assert g.recent_failures == 0


def test_burst_magnitude_stays_reportable():
    """The count is the only thing separating an attack from fumbled codes."""
    g = ratelimit._GlobalPenalty(10, 600, 0.05, 5, clock=_Clock())
    for _ in range(20_000):
        g.record_failure()
    assert g.recent_failures == 20_000


def test_counter_memory_is_bounded_by_the_window_not_the_rate():
    clock = _Clock()
    c = ratelimit._WindowedCounter(600, 10.0, clock=clock)
    for i in range(5000):
        c.add()
        if i % 5 == 0:
            clock.advance(1)  # ~1000s total, well past the 600s window
    assert len(c._buckets) <= 61  # window / bucket, plus the current one
    assert c.value() < 5000  # older buckets really did age out


def test_breadth_registers_even_when_no_network_is_locked():
    """The shape per-network limits are blind to: many sources, few tries."""
    clock = _Clock()
    b = _bucket(clock, free=3)
    g = ratelimit._GlobalPenalty(20, 600, 0.05, 5, clock=clock)

    for net in range(10):
        for _ in range(2):  # under the free allowance everywhere
            b.record_failure(_req(f"198.51.{net}.1"))
            g.record_failure()

    for net in range(10):
        b.check(_req(f"198.51.{net}.1"))  # no network is locked
    assert g.delay() == 0.0
    for _ in range(10):
        g.record_failure()
    assert g.delay() > 0  # but the process notices the aggregate


# ---------------------------------------------------------------------------
# Module-level wiring
# ---------------------------------------------------------------------------


@pytest.fixture
def join_limiter():
    ratelimit._reset_join_limiter_for_tests()
    yield ratelimit
    ratelimit._reset_join_limiter_for_tests()


def test_join_guard_raises_ratelimited_not_httpexception(join_limiter):
    """The route has to collapse throttling into its generic failure.

    A limiter raising HTTPException(429) would make "you are being throttled"
    externally observable, which is itself a signal.
    """
    from fastapi import HTTPException

    for _ in range(50):
        join_limiter.join_record_failure(_req("203.0.113.9"))
    with pytest.raises(ratelimit.RateLimited):
        join_limiter.join_guard(_req("203.0.113.9"))
    assert not issubclass(ratelimit.RateLimited, HTTPException)


def test_ratelimited_carries_no_caller_identifying_payload(join_limiter):
    for _ in range(50):
        join_limiter.join_record_failure(_req("203.0.113.9"))
    with pytest.raises(ratelimit.RateLimited) as excinfo:
        join_limiter.join_guard(_req("203.0.113.9"))
    assert excinfo.value.args == ()
    assert "203.0.113" not in str(excinfo.value)


def test_unattributable_callers_still_generate_process_pressure(join_limiter):
    """The one case where the process-wide control has to carry it alone."""
    anon = SimpleNamespace(client=None)
    for _ in range(5000):
        join_limiter.join_guard(anon)  # never denied — cannot be attributed
        join_limiter.join_record_failure(anon)
    assert join_limiter.join_delay() > 0
    assert join_limiter.join_recent_failures() == 5000


def test_reset_hook_clears_all_three_controls():
    for _ in range(50):
        ratelimit.join_record_failure(_req("203.0.113.9"))
        ratelimit.join_record_success(_req("203.0.113.9"))
    with pytest.raises(ratelimit.RateLimited):
        ratelimit.join_guard(_req("203.0.113.9"))

    ratelimit._reset_join_limiter_for_tests()

    assert ratelimit._join_backoff._state == {}
    assert ratelimit._join_success._state == {}
    assert ratelimit.join_recent_failures() == 0
    ratelimit.join_guard(_req("203.0.113.9"))


# ---------------------------------------------------------------------------
# The database driver must not be talked into logging credentials
# ---------------------------------------------------------------------------


def test_debug_logging_does_not_turn_the_driver_into_a_credential_log(caplog):
    """``LOG_LEVEL=DEBUG`` must not start writing bound parameters to the log.

    The database driver logs every statement together with its bound
    parameters at DEBUG, so a level an operator reaches for when something
    misbehaves would quietly become a dump of every credential this process
    touches. ``database.clamp_driver_logging`` prevents it; this pins the
    behaviour, because the clamp is one line with no other visible effect and
    reads like tidying.
    """
    import logging

    import karaoke_backend.main  # noqa: F401  — the clamp is applied at import

    driver = logging.getLogger("aiosqlite")
    with caplog.at_level(logging.DEBUG):
        # A generic bound-parameter line. Core has no business naming a
        # particular table or credential shape — the property under test is
        # "the driver does not emit its parameters", whatever they are.
        driver.debug(
            "executing ('INSERT INTO t (secret) VALUES (?)', ('S3CRET-VALUE',))"
        )

    assert "S3CRET-VALUE" not in caplog.text
    assert driver.getEffectiveLevel() > logging.DEBUG


# ---------------------------------------------------------------------------
# Success weighting (ruled 2026-07-29): admissions charge their own ledger
# ---------------------------------------------------------------------------


def test_success_churn_locks_a_network_via_join_guard(join_limiter, monkeypatch):
    """A valid-code holder minting tokens throttles like a guesser.

    The ruling's point: the device cap bounds how many rows exist, but only
    this bounds how fast one holder can churn them — and churn past the cap
    evicts real phones.
    """
    clock = _Clock()
    monkeypatch.setattr(ratelimit, "_join_success", _bucket(clock, free=2, base=600))
    r = _req("198.51.100.7")
    for _ in range(3):
        ratelimit.join_record_success(r)
    with pytest.raises(ratelimit.RateLimited):
        ratelimit.join_guard(r)


def test_successes_never_touch_the_failure_ledger_or_the_process(join_limiter, monkeypatch):
    """The ledgers are parallel, not shared.

    A busy room's successes must not spend the allowance sized for failures
    (over LAN the whole room is one /24), and must not raise the process-wide
    delay applied to every other honest guest.
    """
    clock = _Clock()
    monkeypatch.setattr(ratelimit, "_join_success", _bucket(clock, free=2, base=600))
    r = _req("198.51.100.8")
    for _ in range(50):
        ratelimit.join_record_success(r)
    assert ratelimit._join_backoff._state == {}
    assert ratelimit.join_recent_failures() == 0
    assert ratelimit.join_delay() == 0.0


def test_failures_never_advance_the_success_ledger(join_limiter):
    r = _req("198.51.100.9")
    for _ in range(50):
        ratelimit.join_record_failure(r)
    assert ratelimit._join_success._state == {}


def test_a_rooms_worth_of_successes_is_free_at_the_defaults(join_limiter):
    """The default allowance is sized to the device cap (250): a LAN room —
    every phone on one /24 — fills its entire token table without one lock."""
    r = _req("192.168.1.50")
    for _ in range(250):
        ratelimit.join_guard(r)
        ratelimit.join_record_success(r)
    ratelimit.join_guard(r)  # still admitted


def test_a_success_lock_engaging_is_warned_and_rate_limited(join_limiter, monkeypatch, caplog):
    """The lock is silent on the wire by design, so the log is the ONLY signal.

    A success-locked network answers with the generic refusal, never feeds the
    global-pressure log, and stops reaching the storage layer whose device-cap
    warning might otherwise hint. Without this line, a venue that churned
    itself into a lock is a dead QR with no explanation anywhere — and one
    line per refused join would bury the signal under the flood, hence the
    60s throttle on repeats.
    """
    clock = _Clock()
    monkeypatch.setattr(ratelimit, "_join_success", _bucket(clock, free=1, base=600))
    r = _req("198.51.100.10")
    with caplog.at_level("WARNING", logger="karaoke_backend.ratelimit"):
        ratelimit.join_record_success(r)
        assert not any("success churn" in m for m in caplog.messages)
        ratelimit.join_record_success(r)  # engages the lock
        ratelimit.join_record_success(r)  # still locked — throttled, no repeat
    warnings = [m for m in caplog.messages if "success churn" in m]
    assert len(warnings) == 1
    # The full code never appears anywhere near this path; the network key may.
    assert "198.51.100" in warnings[0]
