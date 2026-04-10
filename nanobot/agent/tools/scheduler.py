"""Deterministic scheduler-local tools for observations, recall, and reflow."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from nanobot.agent.scheduler_contract import ProposalBundle, _parse_proposal_bundle
from nanobot.agent.scheduler_executor import SchedulerBundleExecutor
from nanobot.agent.scheduler_state import (
    append_jsonl,
    diff_insights_path,
    load_sync_state,
    memory_dir,
    observations_path,
    read_jsonl,
    read_jsonl_tail,
    read_text,
    reconcile_external_changes,
    sync_state_path,
    utc_now_iso,
)
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)


def _compact_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _parse_datetime(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt

@dataclass(frozen=True, slots=True)
class _ScheduledItem:
    kind: str
    item_id: str
    title: str
    duration: timedelta
    earliest_start: datetime
    latest_end: datetime
    original_start: datetime | None = None
    original_end: datetime | None = None
    priority: int = 0


_FIXED_BLOCK_SCHEMA = ObjectSchema(
    id=StringSchema("Stable block ID"),
    title=StringSchema("Optional block label", nullable=True),
    start=StringSchema("RFC3339/ISO block start"),
    end=StringSchema("RFC3339/ISO block end"),
    required=["id", "start", "end"],
)

_MOVABLE_BLOCK_SCHEMA = ObjectSchema(
    id=StringSchema("Stable block ID"),
    title=StringSchema("Optional block label", nullable=True),
    start=StringSchema("RFC3339/ISO block start"),
    end=StringSchema("RFC3339/ISO block end"),
    flex_before_minutes=IntegerSchema(
        description="How far earlier the block may move", minimum=0, nullable=True
    ),
    flex_after_minutes=IntegerSchema(
        description="How far later the block may move", minimum=0, nullable=True
    ),
    priority=IntegerSchema(description="Higher values schedule earlier", nullable=True),
    required=["id", "start", "end"],
)

_TASK_SCHEMA = ObjectSchema(
    id=StringSchema("Stable task ID"),
    title=StringSchema("Task title"),
    duration_minutes=IntegerSchema(description="Required focus duration", minimum=1),
    earliest_start=StringSchema("RFC3339/ISO earliest scheduling bound", nullable=True),
    latest_end=StringSchema("RFC3339/ISO latest scheduling bound", nullable=True),
    priority=IntegerSchema(description="Higher values schedule earlier", nullable=True),
    required=["id", "title", "duration_minutes"],
)

_OBSERVATION_SCHEMA = ObjectSchema(
    kind=StringSchema("Observation kind"),
    summary=StringSchema("Short observation summary"),
    source=StringSchema("Observation source"),
    evidence=StringSchema("Optional evidence text", nullable=True),
    confidence=IntegerSchema(description="Confidence percentage 0-100", minimum=0, maximum=100, nullable=True),
    scope=StringSchema("Optional scope label", nullable=True),
    linked_entities=ArraySchema(
        StringSchema("Related entity ID"),
        description="Optional related entity IDs",
        nullable=True,
    ),
    effective_at=StringSchema("Optional RFC3339/ISO effective time", nullable=True),
    expires_at=StringSchema("Optional RFC3339/ISO expiry time", nullable=True),
    metadata=ObjectSchema(
        description="Arbitrary extra metadata",
        additional_properties=True,
        nullable=True,
    ),
    required=["kind", "summary", "source"],
)
_GENERIC_OBJECT_SCHEMA = ObjectSchema(additional_properties=True)


class _SchedulerTool(Tool):
    def __init__(self, workspace: Path):
        self._workspace = workspace
        self._memory_dir = memory_dir(workspace)
        self._observations_path = observations_path(workspace)
        self._diff_insights_path = diff_insights_path(workspace)
        self._sync_state_path = sync_state_path(workspace)
        self._memory_path = self._memory_dir / "MEMORY.md"
        self._user_path = workspace / "USER.md"
        self._goals_path = workspace / "GOALS.md"

    def _read_observations(self) -> list[dict[str, Any]]:
        return read_jsonl(self._observations_path)

    def _next_cursor(self) -> int:
        items = self._read_observations()
        if not items:
            return 1
        last = items[-1].get("cursor")
        return int(last) + 1 if isinstance(last, int) else len(items) + 1

    @staticmethod
    def _render_bundle_report(bundle: ProposalBundle, payload: dict[str, Any]) -> str:
        completed = payload.get("completed") or []
        failed = payload.get("failed") or []
        skipped = payload.get("skipped") or []
        lines = [
            f"Applied scheduler proposal bundle `{bundle.bundle_id}`.",
            f"Completed: {len(completed)}",
            f"Failed: {len(failed)}",
            f"Skipped: {len(skipped)}",
            "Partial application: yes" if payload.get("partial_application") else "Partial application: no",
        ]
        if completed:
            lines.append("Completed operations:")
            lines.extend(
                f"- {item.get('operation_id')}: {item.get('summary') or item.get('tool_name')}"
                for item in completed
            )
        if failed:
            lines.append("Failed operations:")
            lines.extend(
                f"- {item.get('operation_id')}: {item.get('detail') or item.get('tool_name')}"
                for item in failed
            )
        if skipped:
            lines.append("Skipped operations:")
            lines.extend(
                f"- {item.get('operation_id')}: {item.get('detail') or item.get('tool_name')}"
                for item in skipped
            )
        recovery_steps = payload.get("recovery_steps") or []
        if recovery_steps:
            lines.append("Recovery:")
            lines.extend(f"- {item}" for item in recovery_steps)
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        observation=_OBSERVATION_SCHEMA,
        required=["observation"],
    )
)
class SchedulerRecordObservationTool(_SchedulerTool):
    @property
    def name(self) -> str:
        return "scheduler_record_observation"

    @property
    def description(self) -> str:
        return "Append a structured scheduler observation to local JSONL state."

    async def execute(self, observation: dict[str, Any], **kwargs: Any) -> str:
        self._memory_dir.mkdir(parents=True, exist_ok=True)
        cursor = append_jsonl(
            self._observations_path,
            {
                "timestamp": utc_now_iso(),
                **observation,
            },
        )
        return _compact_json(
            {
                "cursor": cursor,
                "ok": True,
                "path": "memory/observations.jsonl",
            }
        )


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Optional free-text filter", nullable=True),
        scope=StringSchema("Optional exact scope filter", nullable=True),
        kinds=ArraySchema(
            StringSchema("Observation kind"),
            description="Optional allowed observation kinds",
            nullable=True,
        ),
        include_diff_insights=BooleanSchema(
            description="Include recent external diff insights", default=True
        ),
        limit_diff_insights=IntegerSchema(
            description="Maximum diff insights to return",
            minimum=1,
            maximum=200,
            nullable=True,
        ),
        include_sync_state=BooleanSchema(
            description="Include scheduler sync state metadata", default=True
        ),
        limit_observations=IntegerSchema(
            description="Maximum observations to return",
            minimum=1,
            maximum=200,
            nullable=True,
        ),
        include_goals=BooleanSchema(description="Include GOALS.md if present", default=True),
    )
)
class SchedulerRecallContextTool(_SchedulerTool):
    @property
    def name(self) -> str:
        return "scheduler_recall_context"

    @property
    def description(self) -> str:
        return "Recall compact scheduler planning context from local files."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        query: str | None = None,
        scope: str | None = None,
        kinds: list[str] | None = None,
        include_diff_insights: bool = True,
        limit_diff_insights: int | None = None,
        include_sync_state: bool = True,
        limit_observations: int | None = None,
        include_goals: bool = True,
        **kwargs: Any,
    ) -> str:
        observations = self._read_observations()
        query_lower = query.lower() if query else None
        allowed_kinds = set(kinds or [])

        filtered: list[dict[str, Any]] = []
        for item in reversed(observations):
            haystack = json.dumps(item, ensure_ascii=False).lower()
            if query_lower and query_lower not in haystack:
                continue
            if scope and item.get("scope") != scope:
                continue
            if allowed_kinds and item.get("kind") not in allowed_kinds:
                continue
            filtered.append(item)
            if limit_observations is not None and len(filtered) >= limit_observations:
                break

        diff_insights: list[dict[str, Any]] = []
        if include_diff_insights:
            for item in reversed(read_jsonl(self._diff_insights_path)):
                haystack = json.dumps(item, ensure_ascii=False).lower()
                if query_lower and query_lower not in haystack:
                    continue
                if scope and item.get("scope") not in (None, scope):
                    continue
                diff_insights.append(item)
                if limit_diff_insights is not None and len(diff_insights) >= limit_diff_insights:
                    break

        return _compact_json(
            {
                "diff_insights": list(reversed(diff_insights)),
                "goals": read_text(self._goals_path) if include_goals and self._goals_path.exists() else None,
                "observations": list(reversed(filtered)),
                "operational_memory": read_text(self._memory_path),
                "sync_state": load_sync_state(self._workspace) if include_sync_state else None,
                "user_profile": read_text(self._user_path),
            }
        )


@tool_parameters(
    tool_parameters_schema(
        source=StringSchema("External source name", enum=["calendar", "tasks"]),
        scope=StringSchema("Optional scope label", nullable=True),
        cursor=_GENERIC_OBJECT_SCHEMA,
        changes=ArraySchema(
            _GENERIC_OBJECT_SCHEMA,
            description="Raw external delta items to condense into local diff insights",
            nullable=True,
        ),
        max_insights=IntegerSchema(
            description="Maximum changes to condense into new insights",
            minimum=1,
            maximum=100,
            nullable=True,
        ),
        required=["source"],
    )
)
class SchedulerReconcileExternalChangesTool(_SchedulerTool):
    @property
    def name(self) -> str:
        return "scheduler_reconcile_external_changes"

    @property
    def description(self) -> str:
        return "Persist compact scheduler diff insights and sync cursors for external calendar/task changes."

    async def execute(
        self,
        source: str,
        scope: str | None = None,
        cursor: dict[str, Any] | None = None,
        changes: list[dict[str, Any]] | None = None,
        max_insights: int | None = None,
        **kwargs: Any,
    ) -> str:
        return _compact_json(
            reconcile_external_changes(
                self._workspace,
                source=source,
                scope=scope,
                cursor=cursor,
                changes=changes,
                max_insights=max_insights or 20,
            )
        )


@tool_parameters(
    tool_parameters_schema(
        source=StringSchema("Optional source filter", enum=["calendar", "tasks"], nullable=True),
    )
)
class SchedulerGetSyncStateTool(_SchedulerTool):
    @property
    def name(self) -> str:
        return "scheduler_get_sync_state"

    @property
    def description(self) -> str:
        return "Read scheduler-local sync cursors and reconciliation state."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, source: str | None = None, **kwargs: Any) -> str:
        state = load_sync_state(self._workspace)
        if source:
            state = {
                "dream": state.get("dream", {}),
                "sources": {source: state.get("sources", {}).get(source, {})},
            }
        return _compact_json(state)


@tool_parameters(
    tool_parameters_schema(
        bundle=_GENERIC_OBJECT_SCHEMA,
        required=["bundle"],
    )
)
class SchedulerApplyProposalBundleTool(_SchedulerTool):
    def __init__(self, workspace: Path):
        super().__init__(workspace)
        self._registry = None

    @property
    def name(self) -> str:
        return "scheduler_apply_proposal_bundle"

    @property
    def description(self) -> str:
        return "Apply an approved scheduler proposal bundle with deterministic best-effort execution."

    @property
    def approval_family(self) -> str | None:
        return "timespan_apply"

    def attach_registry(self, registry: Any) -> None:
        self._registry = registry

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        bundle = _parse_proposal_bundle(params.get("bundle"))
        if bundle is None:
            return self.name
        return bundle.approval_scope_key

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        bundle = _parse_proposal_bundle(params.get("bundle"))
        if bundle is None:
            return "Apply the proposed scheduler change bundle."
        lines = [
            f"Apply scheduler bundle '{bundle.summary or bundle.bundle_id}' ({bundle.bundle_id}).",
        ]
        if bundle.expected_side_effects:
            lines.append("Expected effects: " + "; ".join(bundle.expected_side_effects))
        for item in bundle.operations[:10]:
            lines.append(f"- {item.summary or item.tool_name}")
        return "\n".join(lines)

    async def execute(self, bundle: dict[str, Any], **kwargs: Any) -> str:
        parsed = _parse_proposal_bundle(bundle)
        if parsed is None:
            return "Error: invalid proposal bundle"
        if self._registry is None:
            return "Error: scheduler proposal executor is not attached to the runtime registry"
        result = await SchedulerBundleExecutor(self._registry).execute_bundle(parsed)
        return self._render_bundle_report(parsed, result.to_dict())


@tool_parameters(
    tool_parameters_schema(
        window_start=StringSchema("RFC3339/ISO planning window start"),
        window_end=StringSchema("RFC3339/ISO planning window end"),
        fixed_blocks=ArraySchema(
            _FIXED_BLOCK_SCHEMA,
            description="Non-movable occupied blocks",
            nullable=True,
        ),
        movable_blocks=ArraySchema(
            _MOVABLE_BLOCK_SCHEMA,
            description="Existing blocks that may be moved",
            nullable=True,
        ),
        tasks=ArraySchema(
            _TASK_SCHEMA,
            description="Tasks to schedule into the window",
            nullable=True,
        ),
        protected_anchor_ids=ArraySchema(
            StringSchema("Protected ID"),
            description="IDs that must stay fixed",
            nullable=True,
        ),
        constraints=ObjectSchema(
            min_gap_minutes=IntegerSchema(
                description="Gap to keep between scheduled items", minimum=0, nullable=True
            ),
            additional_properties=True,
            nullable=True,
        ),
        required=["window_start", "window_end"],
    )
)
class SchedulerReflowTimespanTool(_SchedulerTool):
    @property
    def name(self) -> str:
        return "scheduler_reflow_timespan"

    @property
    def description(self) -> str:
        return "Deterministically reflow a planning window without side effects."

    @property
    def read_only(self) -> bool:
        return True

    @staticmethod
    def _insert_interval(occupied: list[tuple[datetime, datetime]], interval: tuple[datetime, datetime]) -> None:
        occupied.append(interval)
        occupied.sort(key=lambda item: item[0])

    @staticmethod
    def _find_slot(
        occupied: list[tuple[datetime, datetime]],
        earliest_start: datetime,
        latest_end: datetime,
        duration: timedelta,
        min_gap: timedelta,
    ) -> tuple[datetime, datetime] | None:
        if duration.total_seconds() <= 0:
            return None
        blocked = [(start - min_gap, end + min_gap) for start, end in occupied]
        cursor = earliest_start
        for block_start, block_end in blocked:
            if block_end <= cursor:
                continue
            if cursor + duration <= block_start and cursor + duration <= latest_end:
                return cursor, cursor + duration
            if block_start <= cursor < block_end:
                cursor = block_end
                continue
            if cursor < block_start < cursor + duration:
                cursor = block_end
        if cursor + duration <= latest_end:
            return cursor, cursor + duration
        return None

    @staticmethod
    def _candidate_sort_key(item: _ScheduledItem) -> tuple[Any, ...]:
        ref_start = item.original_start or item.earliest_start
        return (-item.priority, ref_start.isoformat(), item.title, item.item_id)

    async def execute(
        self,
        window_start: str,
        window_end: str,
        fixed_blocks: list[dict[str, Any]] | None = None,
        movable_blocks: list[dict[str, Any]] | None = None,
        tasks: list[dict[str, Any]] | None = None,
        protected_anchor_ids: list[str] | None = None,
        constraints: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> str:
        start = _parse_datetime(window_start)
        end = _parse_datetime(window_end)
        if end <= start:
            return _compact_json(
                {
                    "candidate_placements": [],
                    "diff_operations": [],
                    "unplaced_ids": [],
                    "warnings": ["Planning window end must be after window start."],
                }
            )

        protected = set(protected_anchor_ids or [])
        min_gap_minutes = 0
        if isinstance(constraints, dict) and isinstance(constraints.get("min_gap_minutes"), int):
            min_gap_minutes = max(0, int(constraints["min_gap_minutes"]))
        min_gap = timedelta(minutes=min_gap_minutes)

        occupied: list[tuple[datetime, datetime]] = []
        placements: list[dict[str, Any]] = []
        diff_operations: list[dict[str, Any]] = []
        warnings: list[str] = []
        unplaced_ids: list[str] = []
        candidates: list[_ScheduledItem] = []

        for block in fixed_blocks or []:
            block_start = _parse_datetime(str(block["start"]))
            block_end = _parse_datetime(str(block["end"]))
            if block_end <= block_start:
                warnings.append(f"Skipping invalid fixed block {block.get('id')}.")
                continue
            self._insert_interval(occupied, (block_start, block_end))
            placements.append(
                {
                    "end": block_end.isoformat(),
                    "id": block.get("id"),
                    "kind": "fixed_block",
                    "start": block_start.isoformat(),
                    "title": block.get("title") or "",
                }
            )

        for block in movable_blocks or []:
            item_id = str(block["id"])
            block_start = _parse_datetime(str(block["start"]))
            block_end = _parse_datetime(str(block["end"]))
            if block_end <= block_start:
                warnings.append(f"Skipping invalid movable block {item_id}.")
                continue
            duration = block_end - block_start
            if item_id in protected:
                self._insert_interval(occupied, (block_start, block_end))
                placements.append(
                    {
                        "end": block_end.isoformat(),
                        "id": item_id,
                        "kind": "protected_block",
                        "start": block_start.isoformat(),
                        "title": block.get("title") or "",
                    }
                )
                diff_operations.append(
                    {
                        "action": "keep",
                        "id": item_id,
                        "kind": "movable_block",
                    }
                )
                continue
            flex_before = int(block.get("flex_before_minutes") or 0)
            flex_after = int(block.get("flex_after_minutes") or 0)
            earliest = start if not flex_before else max(start, block_start - timedelta(minutes=flex_before))
            latest = end if not flex_after else min(end, block_end + timedelta(minutes=flex_after))
            candidates.append(
                _ScheduledItem(
                    kind="movable_block",
                    item_id=item_id,
                    title=str(block.get("title") or ""),
                    duration=duration,
                    earliest_start=earliest,
                    latest_end=latest,
                    original_start=block_start,
                    original_end=block_end,
                    priority=int(block.get("priority") or 50),
                )
            )

        for task in tasks or []:
            item_id = str(task["id"])
            duration = timedelta(minutes=int(task["duration_minutes"]))
            earliest = _parse_datetime(str(task["earliest_start"])) if task.get("earliest_start") else start
            latest = _parse_datetime(str(task["latest_end"])) if task.get("latest_end") else end
            candidates.append(
                _ScheduledItem(
                    kind="task",
                    item_id=item_id,
                    title=str(task.get("title") or ""),
                    duration=duration,
                    earliest_start=max(start, earliest),
                    latest_end=min(end, latest),
                    priority=int(task.get("priority") or 0),
                )
            )

        for candidate in sorted(candidates, key=self._candidate_sort_key):
            slot = self._find_slot(
                occupied,
                candidate.earliest_start,
                candidate.latest_end,
                candidate.duration,
                min_gap,
            )
            if slot is None:
                warnings.append(f"Could not place {candidate.kind} '{candidate.item_id}' within the window.")
                unplaced_ids.append(candidate.item_id)
                continue

            placed_start, placed_end = slot
            self._insert_interval(occupied, slot)
            placements.append(
                {
                    "end": placed_end.isoformat(),
                    "id": candidate.item_id,
                    "kind": candidate.kind,
                    "start": placed_start.isoformat(),
                    "title": candidate.title,
                }
            )

            if candidate.kind == "movable_block":
                if candidate.original_start == placed_start and candidate.original_end == placed_end:
                    diff_operations.append(
                        {"action": "keep", "id": candidate.item_id, "kind": candidate.kind}
                    )
                else:
                    diff_operations.append(
                        {
                            "action": "move",
                            "from_end": candidate.original_end.isoformat() if candidate.original_end else None,
                            "from_start": candidate.original_start.isoformat() if candidate.original_start else None,
                            "id": candidate.item_id,
                            "kind": candidate.kind,
                            "to_end": placed_end.isoformat(),
                            "to_start": placed_start.isoformat(),
                        }
                    )
            else:
                diff_operations.append(
                    {
                        "action": "schedule",
                        "end": placed_end.isoformat(),
                        "id": candidate.item_id,
                        "kind": candidate.kind,
                        "start": placed_start.isoformat(),
                    }
                )

        placements.sort(key=lambda item: (item.get("start", ""), item.get("id", "")))
        diff_operations.sort(key=lambda item: (item.get("action", ""), item.get("id", "")))
        warnings.sort()
        unplaced_ids.sort()
        return _compact_json(
            {
                "candidate_placements": placements,
                "diff_operations": diff_operations,
                "unplaced_ids": unplaced_ids,
                "warnings": warnings,
            }
        )


def build_scheduler_tools(workspace: Path) -> list[Tool]:
    """Create deterministic scheduler-local tools."""
    return [
        SchedulerRecordObservationTool(workspace),
        SchedulerRecallContextTool(workspace),
        SchedulerReconcileExternalChangesTool(workspace),
        SchedulerGetSyncStateTool(workspace),
        SchedulerApplyProposalBundleTool(workspace),
        SchedulerReflowTimespanTool(workspace),
    ]
