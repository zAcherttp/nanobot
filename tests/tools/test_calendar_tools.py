from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.agent.tools.calendar import (
    GWSCalendarCreateEventTool,
    GWSCalendarDeleteEventTool,
    GWSCalendarFindFreeTimeTool,
    GWSCalendarGetEventTool,
    GWSCalendarListCalendarsTool,
    GWSCalendarListEventChangesTool,
    GWSCalendarListEventsTool,
    GWSCalendarUpdateEventTool,
)
from nanobot.config.schema import CalendarToolConfig, ExecToolConfig, WebToolsConfig


class _FakeBackend:
    def __init__(self, *, json_result=None, text_result="ok", error: str | None = None):
        self.json_result = json_result
        self.text_result = text_result
        self.error = error
        self.calls: list[tuple[str, ...]] = []

    async def run_json(self, *args: str):
        self.calls.append(tuple(args))
        return self.json_result, self.error

    async def run_text(self, *args: str) -> str:
        self.calls.append(tuple(args))
        return self.text_result if self.error is None else self.error


@pytest.mark.asyncio
async def test_list_calendars_uses_expected_command_shape() -> None:
    backend = _FakeBackend(
        json_result={
            "items": [
                {"summary": "Primary", "id": "primary", "primary": True, "accessRole": "owner"},
                {"summary": "Work", "id": "work@example.com", "accessRole": "reader"},
            ]
        }
    )
    tool = GWSCalendarListCalendarsTool(backend)

    result = await tool.execute(include_hidden=True)

    assert backend.calls == [
        (
            "calendar",
            "calendarList",
            "list",
            "--params",
            '{"showHidden": true}',
            "--format",
            "json",
        )
    ]
    assert "Primary [primary] (primary, owner)" in result
    assert "Work [work@example.com] (reader)" in result


@pytest.mark.asyncio
async def test_list_events_formats_event_summaries() -> None:
    backend = _FakeBackend(
        json_result={
            "items": [
                {
                    "id": "evt-1",
                    "summary": "Standup",
                    "status": "confirmed",
                    "start": {"dateTime": "2026-04-10T09:00:00+07:00"},
                    "end": {"dateTime": "2026-04-10T09:30:00+07:00"},
                }
            ]
        }
    )
    tool = GWSCalendarListEventsTool(backend)

    result = await tool.execute(calendar_id="primary", max_results=5)

    assert "Standup [evt-1]" in result
    assert "2026-04-10T09:00:00+07:00 -> 2026-04-10T09:30:00+07:00" in result


@pytest.mark.asyncio
async def test_get_event_formats_key_fields() -> None:
    backend = _FakeBackend(
        json_result={
            "id": "evt-2",
            "summary": "Review",
            "status": "tentative",
            "start": {"dateTime": "2026-04-10T13:00:00+07:00"},
            "end": {"dateTime": "2026-04-10T14:00:00+07:00"},
            "location": "Room 2",
            "htmlLink": "https://calendar.google.com/event?eid=abc",
            "attendees": [{"email": "a@example.com"}, {"email": "b@example.com"}],
        }
    )
    tool = GWSCalendarGetEventTool(backend)

    result = await tool.execute(event_id="evt-2")

    assert "Event: Review" in result
    assert "Status: tentative" in result
    assert "Location: Room 2" in result
    assert "Attendees: 2" in result


@pytest.mark.asyncio
async def test_find_free_time_merges_busy_windows() -> None:
    backend = _FakeBackend(
        json_result={
            "calendars": {
                "primary": {
                    "busy": [
                        {
                            "start": "2026-04-10T09:00:00+07:00",
                            "end": "2026-04-10T10:00:00+07:00",
                        },
                        {
                            "start": "2026-04-10T11:00:00+07:00",
                            "end": "2026-04-10T11:30:00+07:00",
                        },
                    ]
                }
            }
        }
    )
    tool = GWSCalendarFindFreeTimeTool(backend)

    result = await tool.execute(
        start_time="2026-04-10T08:00:00+07:00",
        end_time="2026-04-10T12:00:00+07:00",
        duration_minutes=30,
    )

    assert "2026-04-10T08:00:00+07:00 -> 2026-04-10T09:00:00+07:00" in result
    assert "2026-04-10T10:00:00+07:00 -> 2026-04-10T11:00:00+07:00" in result
    assert "2026-04-10T11:30:00+07:00 -> 2026-04-10T12:00:00+07:00" in result


@pytest.mark.asyncio
async def test_create_event_uses_insert_helper_flags() -> None:
    backend = _FakeBackend(text_result="Created event")
    tool = GWSCalendarCreateEventTool(backend)

    result = await tool.execute(
        summary="Thesis Review",
        start_time="2026-04-11T10:00:00+07:00",
        end_time="2026-04-11T11:00:00+07:00",
        calendar_id="primary",
        location="Lab",
        description="Review outline",
        attendees=["alice@example.com", "bob@example.com"],
        meet=True,
    )

    assert result == "Created event"
    assert backend.calls == [
        (
            "calendar",
            "+insert",
            "--summary",
            "Thesis Review",
            "--start",
            "2026-04-11T10:00:00+07:00",
            "--end",
            "2026-04-11T11:00:00+07:00",
            "--calendar",
            "primary",
            "--location",
            "Lab",
            "--description",
            "Review outline",
            "--attendee",
            "alice@example.com",
            "--attendee",
            "bob@example.com",
            "--meet",
        )
    ]


@pytest.mark.asyncio
async def test_update_event_uses_patch_shape() -> None:
    backend = _FakeBackend(
        json_result={
            "id": "evt-9",
            "summary": "Updated Review",
            "status": "confirmed",
            "start": {"dateTime": "2026-04-11T12:00:00+07:00"},
            "end": {"dateTime": "2026-04-11T13:00:00+07:00"},
        }
    )
    tool = GWSCalendarUpdateEventTool(backend)

    result = await tool.execute(
        event_id="evt-9",
        calendar_id="primary",
        summary="Updated Review",
        start_time="2026-04-11T12:00:00+07:00",
        end_time="2026-04-11T13:00:00+07:00",
        attendees=["alice@example.com"],
    )

    assert "Updated event: Updated Review [evt-9]" in result
    assert backend.calls == [
        (
            "calendar",
            "events",
            "patch",
            "--params",
            '{"calendarId": "primary", "eventId": "evt-9"}',
            "--json",
            '{"summary": "Updated Review", "start": {"dateTime": "2026-04-11T12:00:00+07:00"}, "end": {"dateTime": "2026-04-11T13:00:00+07:00"}, "attendees": [{"email": "alice@example.com"}]}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_delete_event_uses_delete_shape() -> None:
    backend = _FakeBackend(json_result={})
    tool = GWSCalendarDeleteEventTool(backend)

    result = await tool.execute(event_id="evt-4", calendar_id="work@example.com")

    assert result == "Deleted event evt-4 from work@example.com."
    assert backend.calls == [
        (
            "calendar",
            "events",
            "delete",
            "--params",
            '{"calendarId": "work@example.com", "eventId": "evt-4"}',
            "--format",
            "json",
        )
    ]


@pytest.mark.asyncio
async def test_list_event_changes_returns_compact_json() -> None:
    backend = _FakeBackend(
        json_result={
            "items": [
                {
                    "id": "evt-1",
                    "summary": "Standup",
                    "status": "confirmed",
                    "updated": "2026-04-10T09:30:00Z",
                    "start": {"dateTime": "2026-04-10T09:00:00+07:00"},
                    "end": {"dateTime": "2026-04-10T09:30:00+07:00"},
                }
            ],
            "nextSyncToken": "sync-2",
        }
    )
    tool = GWSCalendarListEventChangesTool(backend)

    result = await tool.execute(calendar_id="primary", sync_token="sync-1", include_deleted=True)

    assert result == (
        '{"calendar_id":"primary","items":[{"deleted":false,"end":"2026-04-10T09:30:00+07:00",'
        '"id":"evt-1","start":"2026-04-10T09:00:00+07:00","status":"confirmed","summary":"Standup",'
        '"updated":"2026-04-10T09:30:00Z"}],"next_sync_token":"sync-2","result_count":1,'
        '"sync_token_used":"sync-1","time_max_used":null,"time_min_used":null}'
    )
    assert backend.calls == [
        (
            "calendar",
            "events",
            "list",
            "--params",
            '{"calendarId": "primary", "showDeleted": true, "syncToken": "sync-1"}',
            "--format",
            "json",
        )
    ]


def _make_loop(tmp_path: Path, *, calendar_enable: bool):
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
        )


def test_scheduler_registers_calendar_suite_only_when_enabled(tmp_path: Path) -> None:
    loop = _make_loop(tmp_path, calendar_enable=True)

    scheduler_tools = loop._runtime_for_mode("scheduler").tools.tool_names
    general_tools = loop._runtime_for_mode("general").tools.tool_names

    assert "mcp_gws_calendar_agenda" in scheduler_tools
    assert "mcp_gws_calendar_create_event" in scheduler_tools
    assert "mcp_gws_calendar_update_event" in scheduler_tools
    assert "mcp_gws_calendar_delete_event" in scheduler_tools
    assert "mcp_gws_calendar_list_event_changes" in scheduler_tools
    assert "mcp_gws_calendar_agenda" not in general_tools


def test_calendar_suite_not_registered_when_disabled(tmp_path: Path) -> None:
    loop = _make_loop(tmp_path, calendar_enable=False)

    scheduler_tools = loop._runtime_for_mode("scheduler").tools.tool_names

    assert "mcp_gws_calendar_agenda" not in scheduler_tools
