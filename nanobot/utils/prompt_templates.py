"""Load and render mode-local runtime templates under ``nanobot/templates/<mode>/agent/``."""

from functools import lru_cache
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader

_TEMPLATES_ROOT = Path(__file__).resolve().parent.parent / "templates"


@lru_cache
def _environment() -> Environment:
    # Plain-text prompts: do not HTML-escape variable values.
    return Environment(
        loader=FileSystemLoader(str(_TEMPLATES_ROOT)),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_template(mode: str, name: str, *, strip: bool = False, **kwargs: Any) -> str:
    """Render ``templates/<mode>/agent/<name>`` with Jinja2.

    Use ``strip=True`` for single-line user-facing strings when the file ends
    with a trailing newline you do not want preserved.
    """
    text = _environment().get_template(f"{mode}/agent/{name}").render(**kwargs)
    return text.rstrip() if strip else text
