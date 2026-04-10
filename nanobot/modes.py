"""Mode definitions, storage helpers, and persistent conversation mode state."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from nanobot.utils.helpers import ensure_dir


@dataclass(frozen=True, slots=True)
class ModeSpec:
    """Static definition for one built-in mode."""

    name: str
    template_namespace: str
    allowed_tools: frozenset[str]

    def workspace_path(self, root_workspace: Path) -> Path:
        """Return the workspace subtree for this mode."""
        return root_workspace / self.name


GENERAL_MODE = ModeSpec(
    name="general",
    template_namespace="general",
    allowed_tools=frozenset(
        {
            "read_file",
            "write_file",
            "edit_file",
            "list_dir",
            "glob",
            "grep",
            "exec",
            "web_search",
            "web_fetch",
            "message",
            "spawn",
            "cron",
        }
    ),
)

SCHEDULER_MODE = ModeSpec(
    name="scheduler",
    template_namespace="scheduler",
    allowed_tools=frozenset(
        {
            "calendar",
            "tasks",
            "read_file",
            "list_dir",
            "glob",
            "grep",
            "web_search",
            "web_fetch",
            "message",
            "cron",
        }
    ),
)

BUILTIN_MODES: tuple[ModeSpec, ...] = (GENERAL_MODE, SCHEDULER_MODE)
BUILTIN_MODE_NAMES = frozenset(mode.name for mode in BUILTIN_MODES)
DEFAULT_MODE = GENERAL_MODE.name


class ModeRegistry:
    """Lookup table for built-in modes."""

    def __init__(self, modes: tuple[ModeSpec, ...] = BUILTIN_MODES):
        self._modes = {mode.name: mode for mode in modes}

    def get(self, name: str) -> ModeSpec:
        """Return a mode spec or raise for an unknown name."""
        try:
            return self._modes[name]
        except KeyError as exc:
            raise ValueError(f"Unknown mode '{name}'") from exc

    def names(self) -> list[str]:
        """Return the available mode names in stable order."""
        return list(self._modes)

    def workspace_path(self, root_workspace: Path, mode: str) -> Path:
        """Return the resolved workspace subtree for one mode."""
        return self.get(mode).workspace_path(root_workspace)


class ConversationModeStore:
    """Persist active mode per conversation key at the root workspace."""

    def __init__(self, root_workspace: Path):
        self.root_workspace = root_workspace
        self._state_path = ensure_dir(root_workspace / "modes") / "conversations.json"
        self._cache: dict[str, str] | None = None

    def _load(self) -> dict[str, str]:
        if self._cache is not None:
            return self._cache
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        cleaned = {
            str(key): str(value)
            for key, value in data.items()
            if str(value) in BUILTIN_MODE_NAMES
        }
        self._cache = cleaned
        return cleaned

    def get(self, key: str) -> str:
        """Return the persisted mode for a conversation, defaulting to general."""
        return self._load().get(key, DEFAULT_MODE)

    def set(self, key: str, mode: str) -> None:
        """Persist a conversation's active mode."""
        if mode not in BUILTIN_MODE_NAMES:
            raise ValueError(f"Unknown mode '{mode}'")
        data = dict(self._load())
        data[key] = mode
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        self._cache = data
