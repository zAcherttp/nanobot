from __future__ import annotations

import json

import pytest

from nanobot.agent.tools.tasks import (
    GWSTasksCompleteTaskTool,
    GWSTasksCreateTaskTool,
    GWSTasksDeleteTaskTool,
    GWSTasksGetTaskTool,
    GWSTasksListTaskChangesTool,
    GWSTasksListTasklistsTool,
    GWSTasksListTasksTool,
    GWSTasksMoveTaskTool,
    GWSTasksUpdateTaskTool,
)


class _FakeBackend:
    def __init__(self, *, json_result=None, error: str | None = None):
        self.json_result = json_result
        self.error = error
        self.calls: list[tuple[str, ...]] = []

    async def run_json(self, *args: str):
        self.calls.append(tuple(args))
        return self.json_result, self.error


@pytest.mark.asyncio
async def test_list_tasklists_uses_expected_command_shape() -> None:
    backend = _FakeBackend(json_result={"items": [{"id": "@default", "title": "Personal"}]})
    tool = GWSTasksListTasklistsTool(backend)

    result = await tool.execute(max_results=5)

    assert result == "Task lists:\n- Personal [@default]"
    assert backend.calls == [
        (
            "tasks",
            "tasklists",
            "list",
            "--params",
            '{"maxResults": 5}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_list_tasks_formats_human_readable_output() -> None:
    backend = _FakeBackend(
        json_result={
            "items": [
                {
                    "id": "task-1",
                    "title": "Draft chapter",
                    "status": "needsAction",
                    "due": "2026-04-12T09:00:00.000Z",
                }
            ]
        }
    )
    tool = GWSTasksListTasksTool(backend)

    result = await tool.execute(tasklist_id="@default", max_results=10)

    assert "Tasks on @default:" in result
    assert "Draft chapter [task-1] (needsAction, due 2026-04-12T09:00:00.000Z)" in result


@pytest.mark.asyncio
async def test_get_task_formats_key_fields() -> None:
    backend = _FakeBackend(
        json_result={
            "id": "task-2",
            "title": "Review notes",
            "status": "completed",
            "updated": "2026-04-10T03:00:00.000Z",
            "notes": "Bring annotated PDF",
        }
    )
    tool = GWSTasksGetTaskTool(backend)

    result = await tool.execute(task_id="task-2")

    assert "Task: Review notes" in result
    assert "Status: completed" in result
    assert "Updated: 2026-04-10T03:00:00.000Z" in result
    assert "Notes:\nBring annotated PDF" in result


@pytest.mark.asyncio
async def test_create_task_uses_insert_command_shape() -> None:
    backend = _FakeBackend(json_result={"id": "task-3", "title": "Write abstract"})
    tool = GWSTasksCreateTaskTool(backend)

    result = await tool.execute(
        title="Write abstract",
        tasklist_id="@default",
        notes="Focus on contribution paragraph",
        due="2026-04-14T10:00:00.000Z",
        previous="task-2",
    )

    assert result == "Created task: Write abstract [task-3]"
    assert backend.calls == [
        (
            "tasks",
            "tasks",
            "insert",
            "--params",
            '{"tasklist": "@default", "previous": "task-2"}',
            "--json",
            '{"title": "Write abstract", "notes": "Focus on contribution paragraph", "due": "2026-04-14T10:00:00.000Z"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_update_task_uses_patch_command_shape() -> None:
    backend = _FakeBackend(json_result={"id": "task-4", "title": "Write abstract v2"})
    tool = GWSTasksUpdateTaskTool(backend)

    result = await tool.execute(task_id="task-4", title="Write abstract v2", status="completed")

    assert result == "Updated task: Write abstract v2 [task-4]"
    assert backend.calls == [
        (
            "tasks",
            "tasks",
            "patch",
            "--params",
            '{"tasklist": "@default", "task": "task-4"}',
            "--json",
            '{"title": "Write abstract v2", "status": "completed"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_move_task_uses_move_command_shape() -> None:
    backend = _FakeBackend(json_result={"id": "task-5", "title": "Move me"})
    tool = GWSTasksMoveTaskTool(backend)

    result = await tool.execute(
        task_id="task-5",
        tasklist_id="work",
        destination_tasklist_id="personal",
        previous="task-4",
    )

    assert result == "Moved task: Move me [task-5]"
    assert backend.calls == [
        (
            "tasks",
            "tasks",
            "move",
            "--params",
            '{"tasklist": "work", "task": "task-5", "destinationTasklist": "personal", "previous": "task-4"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_delete_task_uses_delete_command_shape() -> None:
    backend = _FakeBackend(json_result={})
    tool = GWSTasksDeleteTaskTool(backend)

    result = await tool.execute(task_id="task-6", tasklist_id="work")

    assert result == "Deleted task task-6 from work."
    assert backend.calls == [
        (
            "tasks",
            "tasks",
            "delete",
            "--params",
            '{"tasklist": "work", "task": "task-6"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_complete_task_patches_completed_state() -> None:
    backend = _FakeBackend(json_result={"id": "task-7", "title": "Done"})
    tool = GWSTasksCompleteTaskTool(backend)

    result = await tool.execute(
        task_id="task-7",
        tasklist_id="work",
        completed_at="2026-04-10T04:00:00+00:00",
    )

    assert result == "Completed task: Done [task-7]"
    assert backend.calls == [
        (
            "tasks",
            "tasks",
            "patch",
            "--params",
            '{"tasklist": "work", "task": "task-7"}',
            "--json",
            '{"status": "completed", "completed": "2026-04-10T04:00:00+00:00"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_list_task_changes_returns_compact_json_with_fallback_cursor() -> None:
    backend = _FakeBackend(
        json_result={
            "items": [
                {
                    "id": "task-8",
                    "title": "Shift deadline",
                    "status": "needsAction",
                    "updated": "2026-04-10T05:00:00.000Z",
                    "deleted": False,
                    "hidden": False,
                }
            ]
        }
    )
    tool = GWSTasksListTaskChangesTool(backend)

    result = await tool.execute(tasklist_id="work", sync_token="ignored", updated_min="2026-04-09T00:00:00.000Z")
    payload = json.loads(result)

    assert payload["sync_token_supported"] is False
    assert payload["tasklist_id"] == "work"
    assert payload["next_updated_min"] == "2026-04-10T05:00:00.000Z"
    assert payload["items"][0]["id"] == "task-8"
