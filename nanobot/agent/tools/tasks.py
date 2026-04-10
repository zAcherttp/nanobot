"""Google Tasks tools backed by the gws CLI."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

_DEFAULT_TASKLIST = "@default"


def _compact_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _tasklist_id(tasklist_id: str | None) -> str:
    return tasklist_id or _DEFAULT_TASKLIST


def _task_summary(item: dict[str, Any]) -> str:
    title = item.get("title") or "(untitled)"
    task_id = item.get("id", "unknown")
    status = item.get("status", "needsAction")
    due = item.get("due")
    suffix = f", due {due}" if isinstance(due, str) and due else ""
    return f"- {title} [{task_id}] ({status}{suffix})"


@dataclass(slots=True)
class GWSTasksRunner:
    command: str = "gws"
    timeout: int = 30

    def _argv(self, *args: str) -> list[str]:
        return [self.command, *args]

    def _check_command(self) -> str | None:
        if shutil.which(self.command):
            return None
        return (
            f"Error: gws command '{self.command}' was not found. "
            "Set tools.tasks.command or install gws."
        )

    async def run(self, *args: str) -> tuple[int, str, str]:
        if error := self._check_command():
            return 127, "", error
        completed = await asyncio.to_thread(
            subprocess.run,
            self._argv(*args),
            capture_output=True,
            text=True,
            timeout=self.timeout,
            check=False,
        )
        return completed.returncode, completed.stdout.strip(), completed.stderr.strip()

    async def run_json(self, *args: str) -> tuple[Any | None, str | None]:
        code, stdout, stderr = await self.run(*args)
        if code != 0:
            detail = stderr or stdout or f"exit code {code}"
            return None, f"Error: gws tasks command failed: {detail}"
        if not stdout:
            return {}, None
        try:
            return json.loads(stdout), None
        except json.JSONDecodeError:
            return None, f"Error: gws tasks returned invalid JSON: {stdout[:200]}"


class _TasksTool(Tool):
    def __init__(self, backend: GWSTasksRunner | None = None):
        self._backend = backend or GWSTasksRunner()


@tool_parameters(
    tool_parameters_schema(
        max_results=IntegerSchema(
            description="Maximum task lists to return",
            minimum=1,
            maximum=100,
            nullable=True,
        )
    )
)
class GWSTasksListTasklistsTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_list_tasklists"

    @property
    def description(self) -> str:
        return "List Google Task lists."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "task_read"

    async def execute(self, max_results: int | None = None, **kwargs: Any) -> str:
        argv = ["tasks", "tasklists", "list"]
        if max_results is not None:
            argv.extend(
                ["--params", json.dumps({"maxResults": max_results}, ensure_ascii=False)]
            )
        argv.extend(["--format", "json"])
        payload, error = await self._backend.run_json(*argv)
        if error:
            return error
        items = payload.get("items", []) if isinstance(payload, dict) else []
        if not items:
            return "No task lists found."
        lines = ["Task lists:"]
        for item in items:
            if not isinstance(item, dict):
                continue
            lines.append(f"- {item.get('title') or '(untitled)'} [{item.get('id', 'unknown')}]")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        tasklist_id=StringSchema("Task list ID", nullable=True),
        show_completed=BooleanSchema(description="Include completed tasks", default=False),
        show_hidden=BooleanSchema(description="Include hidden tasks", default=False),
        show_deleted=BooleanSchema(description="Include deleted tasks", default=False),
        updated_min=StringSchema("Optional RFC3339/ISO updated lower bound", nullable=True),
        due_min=StringSchema("Optional RFC3339/ISO due lower bound", nullable=True),
        due_max=StringSchema("Optional RFC3339/ISO due upper bound", nullable=True),
        max_results=IntegerSchema(
            description="Maximum tasks to return",
            minimum=1,
            maximum=100,
            nullable=True,
        ),
    )
)
class GWSTasksListTasksTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_list_tasks"

    @property
    def description(self) -> str:
        return "List tasks in a Google Task list."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "task_read"

    async def execute(
        self,
        tasklist_id: str | None = None,
        show_completed: bool = False,
        show_hidden: bool = False,
        show_deleted: bool = False,
        updated_min: str | None = None,
        due_min: str | None = None,
        due_max: str | None = None,
        max_results: int | None = None,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {
            "tasklist": _tasklist_id(tasklist_id),
            "showCompleted": show_completed,
            "showHidden": show_hidden,
            "showDeleted": show_deleted,
        }
        if updated_min:
            params["updatedMin"] = updated_min
        if due_min:
            params["dueMin"] = due_min
        if due_max:
            params["dueMax"] = due_max
        if max_results is not None:
            params["maxResults"] = max_results
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "list",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        items = payload.get("items", []) if isinstance(payload, dict) else []
        if not items:
            return "No tasks found."
        lines = [f"Tasks on {_tasklist_id(tasklist_id)}:"]
        for item in items:
            if not isinstance(item, dict):
                continue
            lines.append(_task_summary(item))
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        task_id=StringSchema("Task ID"),
        tasklist_id=StringSchema("Task list ID", nullable=True),
        required=["task_id"],
    )
)
class GWSTasksGetTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_get_task"

    @property
    def description(self) -> str:
        return "Get detailed information for a Google Task."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "task_read"

    async def execute(self, task_id: str, tasklist_id: str | None = None, **kwargs: Any) -> str:
        params = {"tasklist": _tasklist_id(tasklist_id), "task": task_id}
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "get",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            return "Task not found."
        lines = [
            f"Task: {payload.get('title') or '(untitled)'}",
            f"ID: {payload.get('id', task_id)}",
            f"Status: {payload.get('status', 'needsAction')}",
        ]
        if payload.get("due"):
            lines.append(f"Due: {payload['due']}")
        if payload.get("updated"):
            lines.append(f"Updated: {payload['updated']}")
        if payload.get("parent"):
            lines.append(f"Parent: {payload['parent']}")
        if payload.get("position"):
            lines.append(f"Position: {payload['position']}")
        if payload.get("notes"):
            lines.append(f"Notes:\n{payload['notes']}")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        title=StringSchema("Task title"),
        tasklist_id=StringSchema("Task list ID", nullable=True),
        notes=StringSchema("Task notes", nullable=True),
        due=StringSchema("Optional RFC3339/ISO due time", nullable=True),
        parent=StringSchema("Parent task ID", nullable=True),
        previous=StringSchema("Previous sibling task ID", nullable=True),
        required=["title"],
    )
)
class GWSTasksCreateTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_create_task"

    @property
    def description(self) -> str:
        return "Create a Google Task."

    @property
    def approval_family(self) -> str | None:
        return "task_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{_tasklist_id(params.get('tasklist_id'))}"

    async def execute(
        self,
        title: str,
        tasklist_id: str | None = None,
        notes: str | None = None,
        due: str | None = None,
        parent: str | None = None,
        previous: str | None = None,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {"tasklist": _tasklist_id(tasklist_id)}
        if parent:
            params["parent"] = parent
        if previous:
            params["previous"] = previous
        body: dict[str, Any] = {"title": title}
        if notes is not None:
            body["notes"] = notes
        if due is not None:
            body["due"] = due
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "insert",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--json",
            json.dumps(body, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            return f"Created task '{title}' on {_tasklist_id(tasklist_id)}."
        return f"Created task: {payload.get('title') or title} [{payload.get('id', 'unknown')}]"


@tool_parameters(
    tool_parameters_schema(
        task_id=StringSchema("Task ID"),
        tasklist_id=StringSchema("Task list ID", nullable=True),
        title=StringSchema("Updated task title", nullable=True),
        notes=StringSchema("Updated task notes", nullable=True),
        due=StringSchema("Updated RFC3339/ISO due time", nullable=True),
        status=StringSchema(
            "Updated task status",
            enum=["needsAction", "completed"],
            nullable=True,
        ),
        completed_at=StringSchema("Completed timestamp override", nullable=True),
        required=["task_id"],
    )
)
class GWSTasksUpdateTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_update_task"

    @property
    def description(self) -> str:
        return "Update a Google Task."

    @property
    def approval_family(self) -> str | None:
        return "task_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{_tasklist_id(params.get('tasklist_id'))}"

    async def execute(
        self,
        task_id: str,
        tasklist_id: str | None = None,
        title: str | None = None,
        notes: str | None = None,
        due: str | None = None,
        status: str | None = None,
        completed_at: str | None = None,
        **kwargs: Any,
    ) -> str:
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if notes is not None:
            body["notes"] = notes
        if due is not None:
            body["due"] = due
        if status is not None:
            body["status"] = status
        if completed_at is not None:
            body["completed"] = completed_at
        if not body:
            return "Error: no task fields were provided to update"
        params = {"tasklist": _tasklist_id(tasklist_id), "task": task_id}
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "patch",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--json",
            json.dumps(body, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            return f"Updated task {task_id} on {_tasklist_id(tasklist_id)}."
        return f"Updated task: {payload.get('title') or '(untitled)'} [{payload.get('id', task_id)}]"


@tool_parameters(
    tool_parameters_schema(
        task_id=StringSchema("Task ID"),
        tasklist_id=StringSchema("Source task list ID", nullable=True),
        destination_tasklist_id=StringSchema("Destination task list ID", nullable=True),
        parent=StringSchema("New parent task ID", nullable=True),
        previous=StringSchema("Previous sibling task ID", nullable=True),
        required=["task_id"],
    )
)
class GWSTasksMoveTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_move_task"

    @property
    def description(self) -> str:
        return "Move a Google Task within or across task lists."

    @property
    def approval_family(self) -> str | None:
        return "task_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        destination = params.get("destination_tasklist_id") or params.get("tasklist_id")
        return f"{self.name}:{_tasklist_id(destination)}"

    async def execute(
        self,
        task_id: str,
        tasklist_id: str | None = None,
        destination_tasklist_id: str | None = None,
        parent: str | None = None,
        previous: str | None = None,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {"tasklist": _tasklist_id(tasklist_id), "task": task_id}
        if destination_tasklist_id:
            params["destinationTasklist"] = destination_tasklist_id
        if parent:
            params["parent"] = parent
        if previous:
            params["previous"] = previous
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "move",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            destination = destination_tasklist_id or _tasklist_id(tasklist_id)
            return f"Moved task {task_id} to {destination}."
        return f"Moved task: {payload.get('title') or '(untitled)'} [{payload.get('id', task_id)}]"


@tool_parameters(
    tool_parameters_schema(
        task_id=StringSchema("Task ID"),
        tasklist_id=StringSchema("Task list ID", nullable=True),
        required=["task_id"],
    )
)
class GWSTasksDeleteTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_delete_task"

    @property
    def description(self) -> str:
        return "Delete a Google Task."

    @property
    def approval_family(self) -> str | None:
        return "task_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{_tasklist_id(params.get('tasklist_id'))}"

    async def execute(self, task_id: str, tasklist_id: str | None = None, **kwargs: Any) -> str:
        params = {"tasklist": _tasklist_id(tasklist_id), "task": task_id}
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "delete",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        _ = payload
        return f"Deleted task {task_id} from {_tasklist_id(tasklist_id)}."


@tool_parameters(
    tool_parameters_schema(
        task_id=StringSchema("Task ID"),
        tasklist_id=StringSchema("Task list ID", nullable=True),
        completed_at=StringSchema("Completed timestamp override", nullable=True),
        required=["task_id"],
    )
)
class GWSTasksCompleteTaskTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_complete_task"

    @property
    def description(self) -> str:
        return "Mark a Google Task as completed."

    @property
    def approval_family(self) -> str | None:
        return "task_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{_tasklist_id(params.get('tasklist_id'))}"

    async def execute(
        self,
        task_id: str,
        tasklist_id: str | None = None,
        completed_at: str | None = None,
        **kwargs: Any,
    ) -> str:
        completion_time = completed_at or datetime.now(UTC).replace(microsecond=0).isoformat()
        params = {"tasklist": _tasklist_id(tasklist_id), "task": task_id}
        body = {"status": "completed", "completed": completion_time}
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "patch",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--json",
            json.dumps(body, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            return f"Completed task {task_id} on {_tasklist_id(tasklist_id)}."
        return f"Completed task: {payload.get('title') or '(untitled)'} [{payload.get('id', task_id)}]"


@tool_parameters(
    tool_parameters_schema(
        tasklist_id=StringSchema("Task list ID", nullable=True),
        sync_token=StringSchema("Unused placeholder for API compatibility", nullable=True),
        updated_min=StringSchema("RFC3339/ISO updated lower bound", nullable=True),
        show_completed=BooleanSchema(description="Include completed tasks", default=True),
        show_hidden=BooleanSchema(description="Include hidden tasks", default=True),
        show_deleted=BooleanSchema(description="Include deleted tasks", default=True),
        max_results=IntegerSchema(
            description="Maximum task changes to return",
            minimum=1,
            maximum=100,
            nullable=True,
        ),
    )
)
class GWSTasksListTaskChangesTool(_TasksTool):
    @property
    def name(self) -> str:
        return "mcp_gws_tasks_list_task_changes"

    @property
    def description(self) -> str:
        return "List Google Task changes in a machine-oriented delta format."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "task_read"

    async def execute(
        self,
        tasklist_id: str | None = None,
        sync_token: str | None = None,
        updated_min: str | None = None,
        show_completed: bool = True,
        show_hidden: bool = True,
        show_deleted: bool = True,
        max_results: int | None = None,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {
            "tasklist": _tasklist_id(tasklist_id),
            "showCompleted": show_completed,
            "showHidden": show_hidden,
            "showDeleted": show_deleted,
        }
        if updated_min:
            params["updatedMin"] = updated_min
        if max_results is not None:
            params["maxResults"] = max_results
        payload, error = await self._backend.run_json(
            "tasks",
            "tasks",
            "list",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error

        items = payload.get("items", []) if isinstance(payload, dict) else []
        compact_items: list[dict[str, Any]] = []
        latest_updated = updated_min
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            updated = item.get("updated")
            if isinstance(updated, str) and (latest_updated is None or updated > latest_updated):
                latest_updated = updated
            compact_items.append(
                {
                    "deleted": bool(item.get("deleted")),
                    "due": item.get("due"),
                    "hidden": bool(item.get("hidden")),
                    "id": item.get("id"),
                    "parent": item.get("parent"),
                    "position": item.get("position"),
                    "status": item.get("status"),
                    "title": item.get("title"),
                    "updated": updated,
                }
            )

        return _compact_json(
            {
                "items": compact_items,
                "next_updated_min": latest_updated,
                "result_count": len(compact_items),
                "sync_token_supported": False,
                "sync_token_used": sync_token,
                "tasklist_id": _tasklist_id(tasklist_id),
                "updated_min_used": updated_min,
            }
        )


def build_gws_tasks_tools(config: Any) -> list[Tool]:
    """Create the built-in gws-backed Google Tasks tool suite."""
    backend = GWSTasksRunner(command=config.command, timeout=config.timeout)
    return [
        GWSTasksListTasklistsTool(backend),
        GWSTasksListTasksTool(backend),
        GWSTasksGetTaskTool(backend),
        GWSTasksCreateTaskTool(backend),
        GWSTasksUpdateTaskTool(backend),
        GWSTasksMoveTaskTool(backend),
        GWSTasksDeleteTaskTool(backend),
        GWSTasksCompleteTaskTool(backend),
        GWSTasksListTaskChangesTool(backend),
    ]
