# SPDX-License-Identifier: AGPL-3.0-only
"""Durable packaging guards (introduced with the src-layout move).

These police the flat -> packaged import migration forever, including files
added later by parallel tracks:

1. No module under src/karaoke_backend/ or tests/ may absolute-import any of
   the historical flat top-level module names.
2. No test source may contain a flat dotted string literal (mock patch
   targets, sys.modules injection keys, importorskip targets): an unrewritten
   string makes a fake silently stop intercepting while its test still runs.
3. The conftest env-before-import contract holds: the engine the suite uses
   is bound to the in-memory sqlite URL that conftest exported BEFORE
   importing anything from the package (locks the contract against future
   import-sorters).
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
SRC_PKG = BACKEND_DIR / "src" / "karaoke_backend"
TESTS_DIR = BACKEND_DIR / "tests"

# Historical flat top-level module names; absolute imports of these are the
# dual-module-identity trap (two engines, two Base metadata registries).
# The list is HISTORICAL: a name stays banned whether or not core still ships
# a module by that name (tunnel moved out to karaoke_premium — an
# `import tunnel` in core would still be the same dual-identity trap, and
# would now resolve to whatever else happened to be on sys.path).
FLAT_TOP_LEVEL = {
    "api",
    "workers",
    "models",
    "database",
    "tunnel",
    "ratelimit",
    "main",
}

# Quote character immediately followed by a flat module name and a dot.
# Deliberately excludes tunnel/ratelimit: no dotted-string use ever existed
# for them, and the two words appear in prose too often to police as strings.
_FLAT_STRING_RE = re.compile(r"""["'](?:api|workers|models|database|main)\.""")


def _py_files(root: Path):
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        yield path


def test_no_flat_absolute_imports() -> None:
    """AST-walk src/karaoke_backend and tests/: zero flat absolute imports."""
    offenders: list[str] = []
    for path in [*_py_files(SRC_PKG), *_py_files(TESTS_DIR)]:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in FLAT_TOP_LEVEL:
                        offenders.append(
                            f"{path.relative_to(BACKEND_DIR)}:{node.lineno} "
                            f"import {alias.name}"
                        )
            elif isinstance(node, ast.ImportFrom):
                if (
                    node.level == 0
                    and node.module
                    and node.module.split(".")[0] in FLAT_TOP_LEVEL
                ):
                    offenders.append(
                        f"{path.relative_to(BACKEND_DIR)}:{node.lineno} "
                        f"from {node.module} import ..."
                    )
    assert not offenders, (
        "flat absolute imports found (rewrite with tools/pkg-import-rewrite.sh):\n"
        + "\n".join(offenders)
    )


def test_no_flat_dotted_string_literals_in_tests() -> None:
    """Regex-scan test sources for flat dotted string literals."""
    offenders: list[str] = []
    for path in _py_files(TESTS_DIR):
        for lineno, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if _FLAT_STRING_RE.search(line):
                offenders.append(
                    f"{path.relative_to(BACKEND_DIR)}:{lineno}: {line.strip()}"
                )
    assert not offenders, (
        "flat dotted string literals found in tests "
        "(rewrite with tools/pkg-import-rewrite.sh):\n" + "\n".join(offenders)
    )


def test_conftest_bound_in_memory_database_before_package_import() -> None:
    """conftest must export the in-memory DATABASE_URL before any package
    import, and the engine the suite actually uses must reflect it."""
    assert os.environ.get("DATABASE_URL") == "sqlite+aiosqlite:///:memory:", (
        "conftest did not bind DATABASE_URL to the in-memory sqlite URL "
        "before collection"
    )
    from karaoke_backend.database import engine

    assert engine.url.database == ":memory:", (
        "engine was built before conftest exported DATABASE_URL — the "
        "env-before-import block in tests/conftest.py must stay physically "
        "above the package imports"
    )


def test_plugin_group_constants_introspect_cleanly() -> None:
    """The plugin ABI constants are well-formed and queryable.

    plugins.py owns the entry-point group names (one block, extensible by a
    later addition). Each of the four original groups must be a distinct
    ``karaoke_backend.``-namespaced string, present in ALL_GROUPS, and safe to
    query via importlib.metadata (introspection never raises)."""
    from karaoke_backend import plugins

    four = [
        plugins.GROUP_CATALOG_PROVIDERS,
        plugins.GROUP_TRANSCRIBERS,
        plugins.GROUP_SEPARATORS,
        plugins.GROUP_LYRICS_PROVIDERS,
    ]
    assert all(isinstance(g, str) and g.startswith("karaoke_backend.") for g in four)
    assert len(set(four)) == 4
    # Owned in one block: the four are exposed for introspection via ALL_GROUPS
    # (which a later addition grows with a fifth constant).
    assert set(four) <= set(plugins.ALL_GROUPS)

    # Every declared group is queryable without raising (empty in core:
    # zero-providers-in-core and the built-ins-are-never-entry-points rules).
    for group in plugins.ALL_GROUPS:
        list(plugins.iter_group(group))


def test_the_repository_url_agrees_across_every_manifest_that_carries_it() -> None:
    """The repo URL is spelled in three files; they must all agree.

    This exists because a protection was deliberately removed. The neutrality
    gate's brand check used to catch a hand-edited repository URL in a package
    manifest, since the URL contains the product name -- which is also why the
    manifests could not declare their URL field at all. An exemption resolved that by
    exempting the URL from the brand check BY CONTENT, on the grounds that it
    is an address rather than a brand literal and does not vary with a rebrand.

    The cost of that ruling is precisely this: the gate can no longer see drift
    between the copies. Nothing else was watching them, so a stale URL in a
    published wheel would ship silently. Same failure shape as the version
    duplication tracked separately -- one value, several hand-maintained homes.
    """
    from karaoke_backend import branding

    url = branding.REPO_URL

    pyproject = tomllib.loads(
        (BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8")
    )
    declared = pyproject["project"]["urls"]["Homepage"]
    assert declared == url, (
        "backend/pyproject.toml declares a different repository URL than "
        f"branding.REPO_URL: {declared!r} != {url!r}"
    )

    # The frontend manifest is a sibling of this package, not part of it, so it
    # is absent from a wheel-only checkout. Skip loudly rather than passing
    # vacuously -- a silent half-check reads as coverage it does not have.
    package_json = BACKEND_DIR.parent / "frontend" / "package.json"
    if not package_json.is_file():
        pytest.skip(f"no frontend manifest at {package_json} -- backend-only tree")

    repository = json.loads(package_json.read_text(encoding="utf-8"))["repository"]
    # npm's form is git+<url>.git, so this is containment rather than equality.
    assert url in repository["url"], (
        "frontend/package.json declares a different repository than "
        f"branding.REPO_URL: {repository['url']!r} does not contain {url!r}"
    )


def test_local_provider_tests_are_ignored_and_shadow_nothing() -> None:
    """The local-only test directory is ignored, and ignores nothing tracked.

    Two halves of one rule, because each without the other has burned this
    repo before.

    The rule has to actually ignore something: it exists so a local or vendor
    provider test can sit in the tree without being committed. Its predecessor
    was the filename glob ``backend/tests/test_provider_*.py``, which is why
    the other half matters — that glob also matched the *tracked*
    ``test_provider_registry.py``. Git keeps serving a tracked file regardless,
    so nothing looked wrong, while every ignore-respecting tool downstream
    dropped it silently. A directory-scoped rule cannot collide with a tracked
    filename, and this test is what keeps it that way.
    """
    repo_root = Path(__file__).resolve().parents[2]
    if not (repo_root / ".git").is_dir():
        pytest.skip("not a git checkout")

    def check_ignore(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "check-ignore", *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )

    # Half one: a file under the local directory is ignored. The path need not
    # exist -- check-ignore matches the rule, not the filesystem.
    probe = check_ignore("--no-index", "backend/tests/local/test_provider_example.py")
    assert probe.returncode == 0, (
        "backend/tests/local/ is no longer ignored, so a local-only provider "
        "test dropped there would be committed by the next `git add -A`."
    )

    # Half two: no rule anywhere shadows a file that is actually tracked.
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], cwd=repo_root, capture_output=True, text=True, check=True
    )
    shadowed = subprocess.run(
        ["git", "check-ignore", "--no-index", "--stdin", "-z"],
        cwd=repo_root,
        input=tracked.stdout,
        capture_output=True,
        text=True,
    )
    # 0 = something matched, 1 = nothing matched (healthy), anything else is a
    # real failure that must not be read as a pass.
    assert shadowed.returncode in (0, 1), f"git check-ignore failed: {shadowed.stderr}"
    hits = [p for p in shadowed.stdout.split("\0") if p]
    assert not hits, "ignore rules shadow these TRACKED files: " + ", ".join(hits)


def test_the_dynamic_version_stays_a_statically_parseable_literal() -> None:
    """pyproject resolves `version` with the setuptools attr: directive, whose
    static path is `ast.literal_eval` over a top-level assignment. The moment
    `__version__` becomes anything computed, setuptools silently falls back to
    IMPORTING the package — which runs the .env load at build time and breaks
    isolated builds, where the runtime dependencies do not exist. Both halves
    are pinned: pyproject still declares the attr, and the assignment is still
    a plain string literal.
    """
    pyproject = tomllib.loads((BACKEND_DIR / "pyproject.toml").read_text())
    assert "version" in pyproject["project"]["dynamic"]
    assert (
        pyproject["tool"]["setuptools"]["dynamic"]["version"]["attr"]
        == "karaoke_backend.__version__"
    )

    tree = ast.parse(
        (BACKEND_DIR / "src" / "karaoke_backend" / "__init__.py").read_text()
    )
    assignments = [
        node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(t, ast.Name) and t.id == "__version__" for t in node.targets
        )
    ]
    assert len(assignments) == 1, "expected exactly one top-level __version__"
    value = assignments[0]
    assert isinstance(value, ast.Constant) and isinstance(value.value, str), (
        "__version__ must stay a single plain string literal: setuptools'"
        " attr: resolution imports the package the moment it is computed"
    )
