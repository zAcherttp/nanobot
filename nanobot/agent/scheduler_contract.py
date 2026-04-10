"""Scheduler-specific planning snapshot, bundles, and decision helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from nanobot.agent.scheduler_state import diff_insights_path, memory_dir, read_jsonl_tail, read_text

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

_ALLOWED_BUNDLE_TOOLS = frozenset(
    {
        "mcp_gws_calendar_create_event",
        "mcp_gws_calendar_update_event",
        "mcp_gws_calendar_delete_event",
        "mcp_gws_tasks_create_task",
        "mcp_gws_tasks_update_task",
        "mcp_gws_tasks_move_task",
        "mcp_gws_tasks_delete_task",
        "mcp_gws_tasks_complete_task",
    }
)

def _truncate_text(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 17)].rstrip() + "\n...[truncated]"

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

    scheduler_memory_dir = memory_dir(workspace)
    return PlanningSnapshot(
        user_profile=_truncate_text(read_text(workspace / "USER.md").strip(), max_profile_chars),
        goals=_truncate_text(read_text(workspace / "GOALS.md").strip(), max_goals_chars),
        operational_memory=_truncate_text(
            read_text(scheduler_memory_dir / "MEMORY.md").strip(),
            max_memory_chars,
        ),
        recent_observations=tuple(
            read_jsonl_tail(scheduler_memory_dir / "observations.jsonl", observation_limit)
        ),
        recent_diff_insights=tuple(
            read_jsonl_tail(diff_insights_path(workspace), diff_limit)
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
    proposal_bundle: "ProposalBundle | None" = None


@dataclass(frozen=True, slots=True)
class ProposalOperation:
    """One deterministic write operation inside a planner proposal bundle."""

    id: str
    tool_name: str
    params: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    depends_on: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tool_name": self.tool_name,
            "params": dict(self.params),
            "summary": self.summary,
            "depends_on": list(self.depends_on),
        }


@dataclass(frozen=True, slots=True)
class ProposalBundle:
    """Serialized planner bundle awaiting approval and execution."""

    bundle_id: str
    summary: str = ""
    approval_family: str | None = None
    operations: tuple[ProposalOperation, ...] = field(default_factory=tuple)
    expected_side_effects: tuple[str, ...] = field(default_factory=tuple)
    rollback_guidance: str = ""

    @property
    def approval_scope_key(self) -> str:
        family = self.approval_family or "scheduler_bundle"
        return f"scheduler_apply_proposal_bundle:{family}:{self.bundle_id}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "bundle_id": self.bundle_id,
            "summary": self.summary,
            "approval_family": self.approval_family,
            "operations": [item.to_dict() for item in self.operations],
            "expected_side_effects": list(self.expected_side_effects),
            "rollback_guidance": self.rollback_guidance,
        }


def _parse_proposal_bundle(value: Any) -> ProposalBundle | None:
    if not isinstance(value, dict):
        return None
    bundle_id = str(value.get("bundle_id") or "").strip()
    if not bundle_id:
        return None
    operations_raw = value.get("operations")
    if not isinstance(operations_raw, list) or not operations_raw:
        return None
    operations: list[ProposalOperation] = []
    seen_ids: set[str] = set()
    for item in operations_raw:
        if not isinstance(item, dict):
            return None
        operation_id = str(item.get("id") or "").strip()
        tool_name = str(item.get("tool_name") or "").strip()
        params = item.get("params")
        if (
            not operation_id
            or operation_id in seen_ids
            or tool_name not in _ALLOWED_BUNDLE_TOOLS
            or not isinstance(params, dict)
        ):
            return None
        depends_on_raw = item.get("depends_on")
        depends_on = (
            tuple(str(dep).strip() for dep in depends_on_raw if str(dep).strip())
            if isinstance(depends_on_raw, list)
            else ()
        )
        operations.append(
            ProposalOperation(
                id=operation_id,
                tool_name=tool_name,
                params=params,
                summary=str(item.get("summary") or "").strip(),
                depends_on=depends_on,
            )
        )
        seen_ids.add(operation_id)
    valid_ids = {item.id for item in operations}
    for operation in operations:
        if any(dep not in valid_ids for dep in operation.depends_on):
            return None
    expected_side_effects_raw = value.get("expected_side_effects")
    expected_side_effects = (
        tuple(str(item).strip() for item in expected_side_effects_raw if str(item).strip())
        if isinstance(expected_side_effects_raw, list)
        else ()
    )
    return ProposalBundle(
        bundle_id=bundle_id,
        summary=str(value.get("summary") or "").strip(),
        approval_family=(
            str(value["approval_family"]).strip()
            if value.get("approval_family") is not None
            else None
        ),
        operations=tuple(operations),
        expected_side_effects=expected_side_effects,
        rollback_guidance=str(value.get("rollback_guidance") or "").strip(),
    )


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
        proposal_bundle=_parse_proposal_bundle(payload.get("proposal_bundle")),
    )
    return visible or None, decision
