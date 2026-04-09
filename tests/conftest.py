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
    test temp data under one top-level ``.temp`` directory avoids those
    permission issues without scattering temp folders across the workspace.
    """

    root = (Path.cwd() / ".temp" / "pytest_tmp_paths").resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = (root / f"case_{uuid4().hex}").resolve()
    path.mkdir()
    return path
