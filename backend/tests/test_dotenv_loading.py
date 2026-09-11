# SPDX-License-Identifier: AGPL-3.0-only
"""backend/.env is loaded, and loaded early enough to matter.

Every test here runs the interpreter in a SUBPROCESS with its cwd set to a
temporary directory. That is not ceremony. The behaviour under test happens at
``import karaoke_backend`` -- by the time an in-process test could run, the
package is long since imported, the ``.env`` decision is made, and monkeypatch
cannot rewind it. A subprocess is the only way to observe a fresh import.

Note the POSITIVE CONTROLS. Two of these tests assert that something did *not*
happen (the real environment was not overridden; a parent directory's file was
not read), and an assertion like that passes just as happily when the feature
has been deleted entirely. Each therefore also asserts that a variable which
could ONLY have come from the file did arrive. Without that, a botched revert
or a refactor that dropped the load would sail straight through the two tests
pinning the decisions those tests exist to protect.

What is pinned:

1. A ``.env`` in the working directory is read.
2. The real process environment WINS over it. This is the one that protects
   deployments: a service may be configured through systemd, and a stray
   ``.env`` in the working directory must never quietly override a unit file.
3. ``DATABASE_URL`` from ``.env`` reaches the engine. This is the ordering
   test, and the reason the load lives in ``__init__`` rather than ``main``:
   ``database.py`` reads that variable at module scope, so a loader running any
   later would leave the engine on the default SQLite path while everything
   else saw the configured one.
4. The load is anchored to cwd, not discovered by walking upwards.
5. The package reports all three of its states honestly.
6. An unreadable file fails with an explanation, not a bare traceback.
7. ``.env.example`` never assigns an empty value -- see that test for why an
   empty assignment is a bug rather than a style question.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _run(
    cwd: Path,
    code: str,
    env_extra: dict[str, str] | None = None,
    expect_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run ``code`` in a fresh interpreter from ``cwd``."""
    env = dict(os.environ)
    # The suite's conftest exports these for the in-memory test engine; leaving
    # them set would mask exactly what these tests are trying to observe.
    for leaked in ("DATABASE_URL", "KARAOKE_DOTENV_PROBE", "KARAOKE_DOTENV_CONTROL"):
        env.pop(leaked, None)
    env.update(env_extra or {})

    proc = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
    )
    if not expect_failure:
        assert proc.returncode == 0, (
            f"subprocess failed ({proc.returncode})\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    return proc


_PROBE_AND_CONTROL = """
    import os
    import karaoke_backend
    print(os.environ.get("KARAOKE_DOTENV_PROBE", "<unset>"))
    print(os.environ.get("KARAOKE_DOTENV_CONTROL", "<unset>"))
    """


def test_a_dotenv_in_the_working_directory_is_read(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("KARAOKE_DOTENV_PROBE=from-file\n", encoding="utf-8")

    out = _run(tmp_path, _PROBE_AND_CONTROL).stdout.splitlines()
    assert out[0] == "from-file", (
        "backend/.env was not read at package import — `cp .env.example .env` "
        "is a no-op again, which is the whole defect this test pins."
    )


def test_the_real_environment_wins_over_the_file(tmp_path: Path) -> None:
    """override=False, and this is the test that keeps it that way.

    The deployed service is configured by systemd. If the file won, a leftover
    .env in the working directory would silently override a unit file — the
    operator would be reading their systemd config and running something else.
    """
    (tmp_path / ".env").write_text(
        "KARAOKE_DOTENV_PROBE=from-file\nKARAOKE_DOTENV_CONTROL=from-file\n",
        encoding="utf-8",
    )

    probe, control = _run(
        tmp_path,
        _PROBE_AND_CONTROL,
        env_extra={"KARAOKE_DOTENV_PROBE": "from-real-environment"},
    ).stdout.splitlines()

    assert probe == "from-real-environment", (
        "the .env file overrode the real process environment; load_dotenv must "
        "be called with override=False"
    )
    # Positive control: without this, deleting the loader entirely still passes
    # the assertion above, since the real environment supplied that value.
    assert control == "from-file", (
        "the control variable never arrived, so the file was not read at all — "
        "the assertion above proved nothing about override behaviour"
    )


def test_database_url_from_dotenv_reaches_the_engine(tmp_path: Path) -> None:
    """The ordering test: the load must beat database.py's module-scope read."""
    db_path = tmp_path / "configured.db"
    (tmp_path / ".env").write_text(
        f"DATABASE_URL=sqlite+aiosqlite:///{db_path}\n", encoding="utf-8"
    )

    out = _run(
        tmp_path,
        """
        from karaoke_backend.database import engine
        print(engine.url.database)
        """,
    ).stdout.strip()
    assert out == str(db_path), (
        "the engine did not pick up DATABASE_URL from .env. The load must "
        "happen in karaoke_backend/__init__.py — database.py reads the "
        "variable at module scope, so anything later is too late."
    )


def test_a_dotenv_in_a_parent_directory_is_ignored(tmp_path: Path) -> None:
    """Anchored to cwd, never discovered by walking up.

    python-dotenv's default search climbs parents until it finds a match. On a
    developer machine that can silently pick up an unrelated .env from above
    the checkout, so the path is explicit instead.
    """
    (tmp_path / ".env").write_text("KARAOKE_DOTENV_PROBE=from-parent\n", encoding="utf-8")
    child = tmp_path / "child"
    child.mkdir()
    # Positive control: proves the loader ran at all in the child, so the
    # "<unset>" below is anchoring and not a missing feature.
    (child / ".env").write_text("KARAOKE_DOTENV_CONTROL=from-child\n", encoding="utf-8")

    probe, control = _run(child, _PROBE_AND_CONTROL).stdout.splitlines()

    assert probe == "<unset>", (
        "a .env from a PARENT directory was loaded; the path must be anchored "
        "to the working directory, not discovered by an upward search"
    )
    assert control == "from-child", (
        "the child's own .env was not read, so the assertion above proved "
        "nothing about upward search"
    )


def test_the_package_reports_all_three_states(tmp_path: Path) -> None:
    """FOUND and LOADED are different, and the difference is the point.

    load_dotenv returns False for a file that exists but yields no variables —
    an empty one, or one commented out end to end, which is precisely the state
    an operator debugging their configuration is usually in. Reporting that as
    "no .env here" answers "why is my .env ignored?" with a falsehood.
    """
    report = """
        import karaoke_backend as kb
        print(f"{kb.DOTENV_FOUND}|{kb.DOTENV_LOADED}|{kb.DOTENV_PATH}")
        """

    found, loaded, path = _run(tmp_path, report).stdout.strip().split("|")
    assert (found, loaded) == ("False", "False"), "reported a file that is not there"
    assert path == str(tmp_path / ".env")

    (tmp_path / ".env").write_text("# every line commented out\n", encoding="utf-8")
    found, loaded, _ = _run(tmp_path, report).stdout.strip().split("|")
    assert (found, loaded) == ("True", "False"), (
        "a present-but-empty .env must report FOUND=True, LOADED=False — "
        "collapsing these is what made the startup log state the opposite of "
        "the truth"
    )

    (tmp_path / ".env").write_text("KARAOKE_DOTENV_PROBE=x\n", encoding="utf-8")
    found, loaded, _ = _run(tmp_path, report).stdout.strip().split("|")
    assert (found, loaded) == ("True", "True")


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="root ignores file permissions, so the unreadable case cannot be staged",
)
def test_an_unreadable_dotenv_fails_with_an_explanation(tmp_path: Path) -> None:
    """Loud, but not a bare traceback out of an import statement.

    Because the load lives in the package __init__, one bad file takes down the
    server, kb-db, the Alembic env and this suite together — and kb-db is the
    tool an operator would reach for to recover. So the error has to name the
    file and the fix.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("KARAOKE_DOTENV_PROBE=x\n", encoding="utf-8")
    env_file.chmod(0o000)

    proc = _run(tmp_path, "import karaoke_backend", expect_failure=True)
    assert proc.returncode != 0, "an unreadable .env was silently ignored"
    assert "Could not read the environment file" in proc.stderr
    assert str(env_file) in proc.stderr, "the error must name the offending file"


def test_the_example_file_assigns_no_empty_values() -> None:
    """`cp .env.example .env` must not break the install it is meant to set up.

    An empty assignment is not "unset" — it is a set value that happens to be
    empty, so ``os.getenv("NAME", "a-default")`` returns "" and the default
    never fires. This was not hypothetical: ``KARAOKE_DEMUCS_PYTHON=`` made
    ``os.path.abspath("")`` resolve to the backend DIRECTORY, and since a
    directory exists, the ``if not DEMUCS_PYTHON.exists()`` guard written to
    catch exactly this was silently satisfied — so separation failed later with
    an opaque spawn error instead of the clear warning.

    It was harmless while nothing read the file. It stopped being harmless the
    moment the loader made ``cp .env.example .env`` actually work, which is why this
    guard exists rather than a one-time fix to the two variables that bit.
    """
    example = BACKEND_DIR / ".env.example"
    offenders = [
        f"{lineno}: {line}"
        for lineno, line in enumerate(
            example.read_text(encoding="utf-8").splitlines(), start=1
        )
        if re.match(r"^[A-Z_][A-Z0-9_]*=\s*$", line)
    ]
    assert not offenders, (
        ".env.example assigns empty values, which defeat os.getenv() defaults "
        "for anyone who copies it. Comment the line out instead of assigning "
        "nothing:\n" + "\n".join(offenders)
    )
