from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.agent.tools.scheduler import (
    SchedulerGetSyncStateTool,
    SchedulerRecallContextTool,
    SchedulerReconcileExternalChangesTool,
    SchedulerRecordObservationTool,
    SchedulerReflowTimespanTool,
)
from nanobot.config.schema import (
    CalendarToolConfig,
    ExecToolConfig,
    TasksToolConfig,
    WebToolsConfig,
)


@pytest.mark.asyncio
async def test_scheduler_record_observation_appends_jsonl(tmp_path: Path) -> None:
    tool = SchedulerRecordObservationTool(tmp_path)

    result = await tool.execute(
        observation={
            "kind": "fatigue_signal",
            "summary": "User reported exhaustion after meetings",
            "source": "chat",
            "scope": "today",
        }
    )

    payload = json.loads(result)
    assert payload["ok"] is True
    observation_path = tmp_path / "memory" / "observations.jsonl"
    lines = observation_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["cursor"] == 1
    assert entry["kind"] == "fatigue_signal"
    assert entry["summary"] == "User reported exhaustion after meetings"


@pytest.mark.asyncio
async def test_scheduler_recall_context_filters_observations_without_mutation(tmp_path: Path) -> None:
    (tmp_path / "memory").mkdir(parents=True)
    (tmp_path / "USER.md").write_text("Prefers mornings for deep work.", encoding="utf-8")
    (tmp_path / "GOALS.md").write_text("Finish thesis by May.", encoding="utf-8")
    (tmp_path / "memory" / "MEMORY.md").write_text("Need lighter afternoon today.", encoding="utf-8")
    (tmp_path / "memory" / "observations.jsonl").write_text(
        '\n'.join(
            [
                json.dumps(
                    {
                        "cursor": 1,
                        "timestamp": "2026-04-10T03:00:00Z",
                        "kind": "energy",
                        "summary": "Strong focus in the morning",
                        "source": "chat",
                        "scope": "weekly",
                    }
                ),
                json.dumps(
                    {
                        "cursor": 2,
                        "timestamp": "2026-04-10T05:00:00Z",
                        "kind": "fatigue",
                        "summary": "Too tired for afternoon admin",
                        "source": "chat",
                        "scope": "today",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    before_user = (tmp_path / "USER.md").read_text(encoding="utf-8")
    tool = SchedulerRecallContextTool(tmp_path)

    result = await tool.execute(query="afternoon", scope="today", limit_observations=5)
    payload = json.loads(result)

    assert payload["user_profile"] == "Prefers mornings for deep work."
    assert payload["operational_memory"] == "Need lighter afternoon today."
    assert payload["goals"] == "Finish thesis by May."
    assert len(payload["observations"]) == 1
    assert payload["observations"][0]["cursor"] == 2
    assert (tmp_path / "USER.md").read_text(encoding="utf-8") == before_user


@pytest.mark.asyncio
async def test_scheduler_reconcile_external_changes_writes_diff_insights_and_sync_state(
    tmp_path: Path,
) -> None:
    tool = SchedulerReconcileExternalChangesTool(tmp_path)

    result = await tool.execute(
        source="calendar",
        scope="primary",
        cursor={"sync_token": "sync-123"},
        changes=[
            {
                "id": "evt-1",
                "summary": "Review block",
                "start": {"dateTime": "2026-04-11T09:00:00+07:00"},
                "updated": "2026-04-10T08:00:00Z",
            },
            {
                "id": "evt-1",
                "summary": "Review block",
                "start": {"dateTime": "2026-04-11T09:00:00+07:00"},
                "updated": "2026-04-10T08:00:00Z",
            },
        ],
    )
    payload = json.loads(result)

    assert payload["recorded_count"] == 1
    assert payload["skipped_count"] == 1
    diff_lines = (tmp_path / "memory" / "diff_insights.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(diff_lines) == 1
    diff_entry = json.loads(diff_lines[0])
    assert diff_entry["source"] == "calendar"
    assert "Review block" in diff_entry["summary"]

    sync_state = json.loads((tmp_path / "memory" / "sync_state.json").read_text(encoding="utf-8"))
    assert sync_state["sources"]["calendar"]["cursor"]["sync_token"] == "sync-123"


@pytest.mark.asyncio
async def test_scheduler_get_sync_state_filters_by_source(tmp_path: Path) -> None:
    (tmp_path / "memory").mkdir(parents=True)
    (tmp_path / "memory" / "sync_state.json").write_text(
        json.dumps(
            {
                "dream": {"last_audited_at": "2026-04-10T01:00:00Z"},
                "sources": {
                    "calendar": {"cursor": {"sync_token": "one"}},
                    "tasks": {"cursor": {"updated_min": "2026-04-10T00:00:00Z"}},
                },
            }
        ),
        encoding="utf-8",
    )
    tool = SchedulerGetSyncStateTool(tmp_path)

    payload = json.loads(await tool.execute(source="tasks"))

    assert "calendar" not in payload["sources"]
    assert payload["sources"]["tasks"]["cursor"]["updated_min"] == "2026-04-10T00:00:00Z"


@pytest.mark.asyncio
async def test_scheduler_reflow_timespan_keeps_protected_anchors_and_is_stable(tmp_path: Path) -> None:
    tool = SchedulerReflowTimespanTool(tmp_path)
    params = {
        "window_start": "2026-04-11T08:00:00+07:00",
        "window_end": "2026-04-11T12:00:00+07:00",
        "fixed_blocks": [
            {
                "id": "lunch-prep",
                "title": "Prep",
                "start": "2026-04-11T10:00:00+07:00",
                "end": "2026-04-11T10:30:00+07:00",
            }
        ],
        "movable_blocks": [
            {
                "id": "anchor-1",
                "title": "Protected thesis slot",
                "start": "2026-04-11T08:00:00+07:00",
                "end": "2026-04-11T09:00:00+07:00",
            },
            {
                "id": "move-1",
                "title": "Flexible admin",
                "start": "2026-04-11T09:00:00+07:00",
                "end": "2026-04-11T09:30:00+07:00",
                "flex_after_minutes": 120,
            },
        ],
        "tasks": [
            {
                "id": "task-1",
                "title": "Deep work",
                "duration_minutes": 60,
                "priority": 10,
            }
        ],
        "protected_anchor_ids": ["anchor-1"],
        "constraints": {"min_gap_minutes": 0},
    }

    first = await tool.execute(**params)
    second = await tool.execute(**params)
    payload = json.loads(first)

    assert first == second
    protected = [item for item in payload["candidate_placements"] if item["id"] == "anchor-1"][0]
    assert protected["start"] == "2026-04-11T08:00:00+07:00"
    assert protected["end"] == "2026-04-11T09:00:00+07:00"


@pytest.mark.asyncio
async def test_scheduler_reflow_timespan_warns_when_items_do_not_fit(tmp_path: Path) -> None:
    tool = SchedulerReflowTimespanTool(tmp_path)

    result = await tool.execute(
        window_start="2026-04-11T08:00:00+07:00",
        window_end="2026-04-11T09:00:00+07:00",
        tasks=[
            {
                "id": "task-too-big",
                "title": "Oversized task",
                "duration_minutes": 120,
            }
        ],
    )
    payload = json.loads(result)

    assert payload["candidate_placements"] == []
    assert payload["unplaced_ids"] == ["task-too-big"]
    assert payload["warnings"] == ["Could not place task 'task-too-big' within the window."]


def _make_loop(tmp_path: Path, *, calendar_enable: bool, tasks_enable: bool):
    from nanobot.agent.loop import AgentLoop
    from nanobot.bus.queue import MessageBus

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 1024

    with (
        patch("nanobot.agent.loop.ContextBuilder"),
        patch("nanobot.agent.loop.SessionManager"),
        patch("nanobot.agent.loop.SubagentManager") as mock_subagents,
    ):
        mock_subagents.return_value.cancel_by_session = AsyncMock(return_value=0)
        return AgentLoop(
            bus=bus,
            provider=provider,
            workspace=tmp_path,
            model="test-model",
            exec_config=ExecToolConfig(enable=False),
            web_config=WebToolsConfig(enable=False),
            calendar_config=CalendarToolConfig(enable=calendar_enable, command="gws"),
            tasks_config=TasksToolConfig(enable=tasks_enable, command="gws"),
        )


def test_scheduler_mode_registers_tasks_and_scheduler_primitives(tmp_path: Path) -> None:
    loop = _make_loop(tmp_path, calendar_enable=False, tasks_enable=True)

    scheduler_tools = loop._runtime_for_mode("scheduler").tools.tool_names
    general_tools = loop._runtime_for_mode("general").tools.tool_names

    assert "mcp_gws_tasks_list_tasks" in scheduler_tools
    assert "mcp_gws_tasks_create_task" in scheduler_tools
    assert "scheduler_record_observation" in scheduler_tools
    assert "scheduler_recall_context" in scheduler_tools
    assert "scheduler_reconcile_external_changes" in scheduler_tools
    assert "scheduler_get_sync_state" in scheduler_tools
    assert "scheduler_reflow_timespan" in scheduler_tools
    assert "mcp_gws_tasks_list_tasks" not in general_tools
    assert "scheduler_record_observation" not in general_tools


def test_tasks_suite_not_registered_when_disabled(tmp_path: Path) -> None:
    loop = _make_loop(tmp_path, calendar_enable=False, tasks_enable=False)

    scheduler_tools = loop._runtime_for_mode("scheduler").tools.tool_names

    assert "mcp_gws_tasks_list_tasks" not in scheduler_tools
    assert "scheduler_record_observation" in scheduler_tools
