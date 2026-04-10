from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from nanobot.agent.scheduler_background import run_scheduler_delta_sync, run_scheduler_reflection
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.tools.scheduler import SchedulerReconcileExternalChangesTool
from nanobot.agent.tools.schema import tool_parameters_schema


class _FakeRuntime(SimpleNamespace):
    workspace: Path
    tools: ToolRegistry
    context: SimpleNamespace


@tool_parameters(tool_parameters_schema())
class _FakeCalendarChangesTool(Tool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_list_event_changes"

    @property
    def description(self) -> str:
        return "fake calendar changes"

    async def execute(self, **kwargs):
        _ = kwargs
        return json.dumps(
            {
                "calendar_id": "primary",
                "items": [
                    {
                        "id": "evt-1",
                        "summary": "Review block",
                        "start": "2026-04-10T09:00:00+07:00",
                        "updated": "2026-04-10T01:00:00Z",
                    }
                ],
                "next_sync_token": "sync-2",
            }
        )


@tool_parameters(tool_parameters_schema())
class _FakeTaskChangesTool(Tool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_list_task_changes"

    @property
    def description(self) -> str:
        return "fake task changes"

    async def execute(self, **kwargs):
        _ = kwargs
        return json.dumps(
            {
                "tasklist_id": "@default",
                "items": [
                    {
                        "id": "task-1",
                        "title": "Write draft",
                        "status": "completed",
                        "updated": "2026-04-10T02:00:00Z",
                    }
                ],
                "next_updated_min": "2026-04-10T02:00:00Z",
            }
        )


def _make_runtime(tmp_path: Path) -> _FakeRuntime:
    tools = ToolRegistry()
    tools.register(_FakeCalendarChangesTool())
    tools.register(_FakeTaskChangesTool())
    tools.register(SchedulerReconcileExternalChangesTool(tmp_path))
    return _FakeRuntime(
        workspace=tmp_path,
        tools=tools,
        context=SimpleNamespace(timezone="Asia/Saigon"),
    )


@pytest.mark.asyncio
async def test_run_scheduler_delta_sync_updates_sync_state_and_diff_insights(tmp_path: Path) -> None:
    runtime = _make_runtime(tmp_path)

    summary = await run_scheduler_delta_sync(runtime)

    assert summary["calendar"]["recorded_count"] == 1
    assert summary["tasks"]["recorded_count"] == 1
    sync_state = json.loads((tmp_path / "memory" / "sync_state.json").read_text(encoding="utf-8"))
    assert sync_state["sources"]["calendar"]["cursor"]["sync_token"] == "sync-2"
    assert sync_state["sources"]["tasks"]["cursor"]["updated_min"] == "2026-04-10T02:00:00Z"
    diff_lines = (tmp_path / "memory" / "diff_insights.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(diff_lines) == 2


@pytest.mark.asyncio
async def test_run_scheduler_reflection_uses_default_phase_and_flagged_items(
    tmp_path: Path, monkeypatch
) -> None:
    runtime = _make_runtime(tmp_path)
    (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
    (tmp_path / "memory" / "observations.jsonl").write_text(
        json.dumps(
            {
                "cursor": 1,
                "kind": "followup_flag",
                "summary": "Deep work block",
                "metadata": {"flag_for_followup": True},
                "linked_entities": ["evt-1"],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "nanobot.agent.scheduler_background._now_in_timezone",
        lambda timezone: datetime.fromisoformat("2026-04-10T12:30:00+07:00"),
    )

    first = await run_scheduler_reflection(runtime)
    second = await run_scheduler_reflection(runtime)

    assert first == ["How did this morning item go: Deep work block?"]
    assert second == []


@pytest.mark.asyncio
async def test_run_scheduler_reflection_uses_learned_night_end_from_profile(
    tmp_path: Path, monkeypatch
) -> None:
    runtime = _make_runtime(tmp_path)
    (tmp_path / "USER.md").write_text("workday_end: 18:00\n", encoding="utf-8")

    monkeypatch.setattr(
        "nanobot.agent.scheduler_background._now_in_timezone",
        lambda timezone: datetime.fromisoformat("2026-04-10T18:30:00+07:00"),
    )

    messages = await run_scheduler_reflection(runtime)

    assert messages == ["How did the day end? What still needs to move, defer, or be protected for tomorrow?"]
