"""Shared pytest fixtures for repository-local test execution."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest


@pytest.fixture
def tmp_path() -> Path:
    """Provide a writable temp directory inside the repository workspace.

    Some Windows environments deny access to pytest's default temp roots,
    which breaks any test using the built-in ``tmp_path`` fixture. Keeping
    test temp data under ``.testcache`` avoids those permission issues.
    """

    root = (Path.cwd() / ".testcache" / "pytest_tmp_paths").resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = (root / f"case_{uuid4().hex}").resolve()
    path.mkdir()
    return path
