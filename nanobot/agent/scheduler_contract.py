"""Scheduler-specific planning snapshot and decision helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

PlannerStatus = Literal[
    "done",
    "needs_approval",
    "needs_clarification",
    "schedule_followup",
    "blocked",
]

_PLANNER_DECISION_PATTERN = re.compile(
    r"\s*<planner_decision>\s*(\{.*\})\s*</planner_decision>\s*$",
    re.DOTALL,
)
_VALID_PLANNER_STATUSES = frozenset(
    {"done", "needs_approval", "needs_clarification", "schedule_followup", "blocked"}
)


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def _truncate_text(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 17)].rstrip() + "\n...[truncated]"


def _read_jsonl_tail(path: Path, limit: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict):
                    items.append(payload)
    except FileNotFoundError:
        return []
    if limit <= 0:
        return []
    return items[-limit:]


def _render_record_lines(items: list[dict[str, Any]], *, fallback_title: str) -> str:
    if not items:
        return "(none)"
    lines: list[str] = []
    for item in items:
        when = (
            item.get("timestamp")
            or item.get("effective_at")
            or item.get("updated_at")
            or item.get("created_at")
        )
        title = item.get("summary") or item.get("title") or item.get("kind") or fallback_title
        meta: list[str] = []
        for key in ("kind", "scope", "source", "confidence"):
            value = item.get(key)
            if value not in (None, "", []):
                meta.append(f"{key}={value}")
        linked = item.get("linked_entities")
        if isinstance(linked, list) and linked:
            meta.append("linked=" + ",".join(str(part) for part in linked[:4]))
        prefix = f"[{when}] " if when else ""
        suffix = f" ({'; '.join(meta)})" if meta else ""
        lines.append(f"- {prefix}{title}{suffix}")
    return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class PlanningSnapshot:
    """Compact scheduler planning state assembled from local files."""

    user_profile: str = ""
    operational_memory: str = ""
    goals: str = ""
    recent_observations: tuple[dict[str, Any], ...] = ()
    recent_diff_insights: tuple[dict[str, Any], ...] = ()

    def render(self) -> str:
        return "\n\n".join(
            [
                "# Planning Snapshot",
                "## Behavioral Profile\n"
                + (self.user_profile or "(none recorded)"),
                "## Active Goals\n"
                + (self.goals or "(none recorded)"),
                "## Operational Memory\n"
                + (self.operational_memory or "(none recorded)"),
                "## Recent Observations\n"
                + _render_record_lines(
                    list(self.recent_observations),
                    fallback_title="observation",
                ),
                "## Recent External Diffs\n"
                + _render_record_lines(
                    list(self.recent_diff_insights),
                    fallback_title="external change",
                ),
            ]
        )


def build_planning_snapshot(
    workspace: Path,
    *,
    max_profile_chars: int = 1200,
    max_goals_chars: int = 1200,
    max_memory_chars: int = 1200,
    observation_limit: int = 6,
    diff_limit: int = 6,
) -> PlanningSnapshot:
    """Load a compact scheduler planning snapshot from workspace files."""

    memory_dir = workspace / "memory"
    return PlanningSnapshot(
        user_profile=_truncate_text(_read_text(workspace / "USER.md"), max_profile_chars),
        goals=_truncate_text(_read_text(workspace / "GOALS.md"), max_goals_chars),
        operational_memory=_truncate_text(
            _read_text(memory_dir / "MEMORY.md"),
            max_memory_chars,
        ),
        recent_observations=tuple(
            _read_jsonl_tail(memory_dir / "observations.jsonl", observation_limit)
        ),
        recent_diff_insights=tuple(
            _read_jsonl_tail(memory_dir / "diff_insights.jsonl", diff_limit)
        ),
    )


@dataclass(frozen=True, slots=True)
class PlannerDecision:
    """Structured scheduler stop contract emitted by the model."""

    status: PlannerStatus
    summary: str = ""
    proposed_changes: tuple[Any, ...] = field(default_factory=tuple)
    approval_family: str | None = None
    follow_up_at: str | None = None
    blockers: tuple[str, ...] = field(default_factory=tuple)


def parse_planner_decision(content: str | None) -> tuple[str | None, PlannerDecision | None]:
    """Strip and parse the trailing scheduler decision block, if present."""

    if not content:
        return content, None
    match = _PLANNER_DECISION_PATTERN.search(content)
    if not match:
        return content, None

    visible = content[: match.start()].strip()
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return visible or content, None
    if not isinstance(payload, dict):
        return visible or content, None

    status = payload.get("status")
    if status not in _VALID_PLANNER_STATUSES:
        return visible or content, None

    summary = str(payload.get("summary") or "").strip()
    proposed = payload.get("proposed_changes")
    blockers = payload.get("blockers")
    decision = PlannerDecision(
        status=status,
        summary=summary,
        proposed_changes=tuple(proposed) if isinstance(proposed, list) else (),
        approval_family=(
            str(payload["approval_family"]).strip()
            if payload.get("approval_family") is not None
            else None
        ),
        follow_up_at=(
            str(payload["follow_up_at"]).strip()
            if payload.get("follow_up_at") is not None
            else None
        ),
        blockers=tuple(str(item) for item in blockers) if isinstance(blockers, list) else (),
    )
    return visible or None, decision
