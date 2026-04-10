"""Google Calendar tools backed by the gws CLI."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)


def _parse_iso_datetime(value: str, timezone: str | None = None) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(timezone or "UTC"))
    return dt


def _format_event_time(block: dict[str, Any] | None) -> str:
    if not isinstance(block, dict):
        return "unknown"
    if isinstance(block.get("dateTime"), str):
        return block["dateTime"]
    if isinstance(block.get("date"), str):
        return block["date"]
    return "unknown"


def _merge_busy_ranges(ranges: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda item: item[0])
    merged: list[tuple[datetime, datetime]] = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _compact_json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


@dataclass(slots=True)
class GWSCalendarRunner:
    command: str = "gws"
    timeout: int = 30

    def _argv(self, *args: str) -> list[str]:
        return [self.command, *args]

    def _check_command(self) -> str | None:
        if shutil.which(self.command):
            return None
        return (
            f"Error: gws command '{self.command}' was not found. "
            "Set tools.calendar.command or install gws."
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
            return None, f"Error: gws calendar command failed: {detail}"
        if not stdout:
            return {}, None
        try:
            return json.loads(stdout), None
        except json.JSONDecodeError:
            return None, f"Error: gws calendar returned invalid JSON: {stdout[:200]}"

    async def run_text(self, *args: str) -> str:
        code, stdout, stderr = await self.run(*args)
        if code != 0:
            detail = stderr or stdout or f"exit code {code}"
            return f"Error: gws calendar command failed: {detail}"
        return stdout or "(no output)"


class _CalendarTool(Tool):
    def __init__(self, backend: GWSCalendarRunner | None = None):
        self._backend = backend or GWSCalendarRunner()


@tool_parameters(
    tool_parameters_schema(
        today=BooleanSchema(description="Show only today's events", default=False),
        tomorrow=BooleanSchema(description="Show only tomorrow's events", default=False),
        week=BooleanSchema(description="Show this week's events", default=False),
        days=IntegerSchema(
            description="Show this many days ahead",
            minimum=1,
            maximum=31,
            nullable=True,
        ),
        calendar=StringSchema("Optional calendar name or ID filter", nullable=True),
        timezone=StringSchema("Optional IANA timezone override", nullable=True),
    )
)
class GWSCalendarAgendaTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_agenda"

    @property
    def description(self) -> str:
        return "Show upcoming Google Calendar events in agenda form."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        scope = "agenda"
        if params.get("today"):
            scope = "today's agenda"
        elif params.get("tomorrow"):
            scope = "tomorrow's agenda"
        elif params.get("week"):
            scope = "this week's agenda"
        elif params.get("days") is not None:
            scope = f"next {params['days']} days"
        calendar = params.get("calendar") or "all calendars"
        return f"Read Google Calendar agenda for {scope} on {calendar}."

    async def execute(
        self,
        today: bool = False,
        tomorrow: bool = False,
        week: bool = False,
        days: int | None = None,
        calendar: str | None = None,
        timezone: str | None = None,
        **kwargs: Any,
    ) -> str:
        argv = ["calendar", "+agenda"]
        if today:
            argv.append("--today")
        if tomorrow:
            argv.append("--tomorrow")
        if week:
            argv.append("--week")
        if days is not None:
            argv.extend(["--days", str(days)])
        if calendar:
            argv.extend(["--calendar", calendar])
        if timezone:
            argv.extend(["--timezone", timezone])
        return await self._backend.run_text(*argv)


@tool_parameters(
    tool_parameters_schema(
        include_hidden=BooleanSchema(
            description="Include hidden calendars in the result", default=False
        ),
    )
)
class GWSCalendarListCalendarsTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_list_calendars"

    @property
    def description(self) -> str:
        return "List available Google Calendars."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        hidden = " including hidden calendars" if params.get("include_hidden") else ""
        return f"List available Google Calendars{hidden}."

    async def execute(self, include_hidden: bool = False, **kwargs: Any) -> str:
        params = {"showHidden": include_hidden}
        payload, error = await self._backend.run_json(
            "calendar",
            "calendarList",
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
            return "No calendars found."
        lines = ["Calendars:"]
        for item in items:
            if not isinstance(item, dict):
                continue
            name = item.get("summary") or item.get("id") or "Unnamed"
            calendar_id = item.get("id", "unknown")
            suffix: list[str] = []
            if item.get("primary"):
                suffix.append("primary")
            if item.get("accessRole"):
                suffix.append(str(item["accessRole"]))
            meta = f" ({', '.join(suffix)})" if suffix else ""
            lines.append(f"- {name} [{calendar_id}]{meta}")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        calendar_id=StringSchema("Calendar ID", nullable=True),
        time_min=StringSchema("RFC3339/ISO start filter", nullable=True),
        time_max=StringSchema("RFC3339/ISO end filter", nullable=True),
        max_results=IntegerSchema(
            description="Maximum events to return",
            minimum=1,
            maximum=100,
            nullable=True,
        ),
        query=StringSchema("Optional free-text event query", nullable=True),
        include_deleted=BooleanSchema(description="Include deleted events", default=False),
    )
)
class GWSCalendarListEventsTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_list_events"

    @property
    def description(self) -> str:
        return "List events for a Google Calendar."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        calendar_id = params.get("calendar_id") or "primary"
        parts = [f"List Google Calendar events on {calendar_id}"]
        if params.get("time_min") or params.get("time_max"):
            parts.append(
                f"between {params.get('time_min') or 'now'} and {params.get('time_max') or 'later'}"
            )
        if params.get("query"):
            parts.append(f"matching '{params['query']}'")
        return " ".join(parts) + "."

    async def execute(
        self,
        calendar_id: str | None = None,
        time_min: str | None = None,
        time_max: str | None = None,
        max_results: int | None = None,
        query: str | None = None,
        include_deleted: bool = False,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {
            "calendarId": calendar_id or "primary",
            "singleEvents": True,
            "showDeleted": include_deleted,
        }
        if time_min:
            params["timeMin"] = time_min
        if time_max:
            params["timeMax"] = time_max
        if max_results is not None:
            params["maxResults"] = max_results
        if query:
            params["q"] = query
        payload, error = await self._backend.run_json(
            "calendar",
            "events",
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
            return "No calendar events found."
        lines = ["Events:"]
        for item in items:
            if not isinstance(item, dict):
                continue
            summary = item.get("summary") or "(untitled)"
            event_id = item.get("id", "unknown")
            start = _format_event_time(item.get("start"))
            end = _format_event_time(item.get("end"))
            status = item.get("status", "confirmed")
            lines.append(f"- {summary} [{event_id}] {start} -> {end} ({status})")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        event_id=StringSchema("Google Calendar event ID"),
        calendar_id=StringSchema("Calendar ID", nullable=True),
        required=["event_id"],
    )
)
class GWSCalendarGetEventTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_get_event"

    @property
    def description(self) -> str:
        return "Get detailed information for a Google Calendar event."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        calendar_id = params.get("calendar_id") or "primary"
        return f"Get Google Calendar event {params.get('event_id')} from {calendar_id}."

    async def execute(self, event_id: str, calendar_id: str | None = None, **kwargs: Any) -> str:
        params = {"calendarId": calendar_id or "primary", "eventId": event_id}
        payload, error = await self._backend.run_json(
            "calendar",
            "events",
            "get",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict) or not payload:
            return "Event not found."
        attendees = payload.get("attendees") or []
        lines = [
            f"Event: {payload.get('summary') or '(untitled)'}",
            f"ID: {payload.get('id', event_id)}",
            f"Status: {payload.get('status', 'confirmed')}",
            f"Start: {_format_event_time(payload.get('start'))}",
            f"End: {_format_event_time(payload.get('end'))}",
        ]
        if payload.get("location"):
            lines.append(f"Location: {payload['location']}")
        if payload.get("htmlLink"):
            lines.append(f"Link: {payload['htmlLink']}")
        if attendees:
            lines.append(f"Attendees: {len(attendees)}")
        if payload.get("description"):
            lines.append(f"Description:\n{payload['description']}")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        start_time=StringSchema("Window start in RFC3339/ISO format"),
        end_time=StringSchema("Window end in RFC3339/ISO format"),
        duration_minutes=IntegerSchema(
            description="Minimum free-slot duration in minutes",
            minimum=1,
            maximum=1440,
        ),
        calendar_ids=ArraySchema(
            StringSchema("Calendar ID"),
            description="Calendars to include in the free/busy check",
            nullable=True,
        ),
        timezone=StringSchema("Optional IANA timezone override", nullable=True),
        max_results=IntegerSchema(
            description="Maximum free slots to return",
            minimum=1,
            maximum=50,
            nullable=True,
        ),
        required=["start_time", "end_time", "duration_minutes"],
    )
)
class GWSCalendarFindFreeTimeTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_find_free_time"

    @property
    def description(self) -> str:
        return "Find available free-time slots across one or more Google Calendars."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        calendars = params.get("calendar_ids") or ["primary"]
        return (
            f"Find {params.get('duration_minutes')} minute free slots between "
            f"{params.get('start_time')} and {params.get('end_time')} across {', '.join(calendars)}."
        )

    async def execute(
        self,
        start_time: str,
        end_time: str,
        duration_minutes: int,
        calendar_ids: list[str] | None = None,
        timezone: str | None = None,
        max_results: int | None = None,
        **kwargs: Any,
    ) -> str:
        calendars = calendar_ids or ["primary"]
        body: dict[str, Any] = {
            "timeMin": start_time,
            "timeMax": end_time,
            "items": [{"id": calendar_id} for calendar_id in calendars],
        }
        if timezone:
            body["timeZone"] = timezone
        payload, error = await self._backend.run_json(
            "calendar",
            "freebusy",
            "query",
            "--json",
            json.dumps(body, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict):
            return "Error: unexpected free/busy response."

        window_start = _parse_iso_datetime(start_time, timezone)
        window_end = _parse_iso_datetime(end_time, timezone)
        duration_seconds = duration_minutes * 60
        busy_ranges: list[tuple[datetime, datetime]] = []
        calendars_block = payload.get("calendars", {})
        if isinstance(calendars_block, dict):
            for calendar in calendars_block.values():
                busy_items = calendar.get("busy", []) if isinstance(calendar, dict) else []
                for busy in busy_items:
                    if not isinstance(busy, dict):
                        continue
                    busy_start = _parse_iso_datetime(str(busy.get("start")), timezone)
                    busy_end = _parse_iso_datetime(str(busy.get("end")), timezone)
                    busy_ranges.append((max(window_start, busy_start), min(window_end, busy_end)))

        merged = _merge_busy_ranges(
            [(start, end) for start, end in busy_ranges if start < end]
        )
        slots: list[tuple[datetime, datetime]] = []
        cursor = window_start
        for busy_start, busy_end in merged:
            if (busy_start - cursor).total_seconds() >= duration_seconds:
                slots.append((cursor, busy_start))
            cursor = max(cursor, busy_end)
        if (window_end - cursor).total_seconds() >= duration_seconds:
            slots.append((cursor, window_end))

        if max_results is not None:
            slots = slots[:max_results]
        if not slots:
            return "No free time slots found."
        lines = [f"Free slots ({duration_minutes}+ min):"]
        for start, end in slots:
            lines.append(f"- {start.isoformat()} -> {end.isoformat()}")
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        summary=StringSchema("Event title"),
        start_time=StringSchema("RFC3339/ISO event start time"),
        end_time=StringSchema("RFC3339/ISO event end time"),
        calendar_id=StringSchema("Calendar ID", nullable=True),
        location=StringSchema("Event location", nullable=True),
        description=StringSchema("Event description", nullable=True),
        attendees=ArraySchema(
            StringSchema("Attendee email"),
            description="Optional attendee email addresses",
            nullable=True,
        ),
        meet=BooleanSchema(description="Add a Google Meet link", default=False),
        required=["summary", "start_time", "end_time"],
    )
)
class GWSCalendarCreateEventTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_create_event"

    @property
    def description(self) -> str:
        return "Create a Google Calendar event."

    @property
    def approval_family(self) -> str | None:
        return "calendar_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{params.get('calendar_id') or 'primary'}"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        attendees = params.get("attendees") or []
        details = [
            f"Create event '{params.get('summary')}'",
            f"on {params.get('calendar_id') or 'primary'}",
            f"from {params.get('start_time')} to {params.get('end_time')}",
        ]
        if params.get("location"):
            details.append(f"at {params['location']}")
        if attendees:
            details.append(f"with attendees {', '.join(attendees)}")
        if params.get("meet"):
            details.append("and add a Google Meet link")
        return " ".join(details) + "."

    async def execute(
        self,
        summary: str,
        start_time: str,
        end_time: str,
        calendar_id: str | None = None,
        location: str | None = None,
        description: str | None = None,
        attendees: list[str] | None = None,
        meet: bool = False,
        **kwargs: Any,
    ) -> str:
        argv = [
            "calendar",
            "+insert",
            "--summary",
            summary,
            "--start",
            start_time,
            "--end",
            end_time,
        ]
        if calendar_id:
            argv.extend(["--calendar", calendar_id])
        if location:
            argv.extend(["--location", location])
        if description:
            argv.extend(["--description", description])
        for attendee in attendees or []:
            argv.extend(["--attendee", attendee])
        if meet:
            argv.append("--meet")
        return await self._backend.run_text(*argv)


@tool_parameters(
    tool_parameters_schema(
        event_id=StringSchema("Google Calendar event ID"),
        calendar_id=StringSchema("Calendar ID", nullable=True),
        summary=StringSchema("Updated event title", nullable=True),
        start_time=StringSchema("Updated RFC3339/ISO event start time", nullable=True),
        end_time=StringSchema("Updated RFC3339/ISO event end time", nullable=True),
        location=StringSchema("Updated event location", nullable=True),
        description=StringSchema("Updated event description", nullable=True),
        status=StringSchema(
            "Updated event status",
            enum=["confirmed", "tentative", "cancelled"],
            nullable=True,
        ),
        attendees=ArraySchema(
            StringSchema("Attendee email"),
            description="Optional full replacement attendee email list",
            nullable=True,
        ),
        clear_attendees=BooleanSchema(
            description="Replace attendees with an empty list", default=False
        ),
        required=["event_id"],
    )
)
class GWSCalendarUpdateEventTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_update_event"

    @property
    def description(self) -> str:
        return "Update an existing Google Calendar event."

    @property
    def approval_family(self) -> str | None:
        return "calendar_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{params.get('calendar_id') or 'primary'}"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        updates: list[str] = []
        if params.get("summary"):
            updates.append(f"title to '{params['summary']}'")
        if params.get("start_time") or params.get("end_time"):
            updates.append(
                f"time to {params.get('start_time') or '?'} -> {params.get('end_time') or '?'}"
            )
        if params.get("location"):
            updates.append(f"location to '{params['location']}'")
        if params.get("status"):
            updates.append(f"status to {params['status']}")
        if params.get("attendees"):
            updates.append(f"attendees to {', '.join(params['attendees'])}")
        if params.get("clear_attendees"):
            updates.append("clear attendees")
        change_text = "; ".join(updates) if updates else "change unspecified fields"
        return (
            f"Update Google Calendar event {params.get('event_id')} on "
            f"{params.get('calendar_id') or 'primary'}: {change_text}."
        )

    async def execute(
        self,
        event_id: str,
        calendar_id: str | None = None,
        summary: str | None = None,
        start_time: str | None = None,
        end_time: str | None = None,
        location: str | None = None,
        description: str | None = None,
        status: str | None = None,
        attendees: list[str] | None = None,
        clear_attendees: bool = False,
        **kwargs: Any,
    ) -> str:
        body: dict[str, Any] = {}
        if summary is not None:
            body["summary"] = summary
        if start_time is not None:
            body["start"] = {"dateTime": start_time}
        if end_time is not None:
            body["end"] = {"dateTime": end_time}
        if location is not None:
            body["location"] = location
        if description is not None:
            body["description"] = description
        if status is not None:
            body["status"] = status
        if clear_attendees:
            body["attendees"] = []
        elif attendees is not None:
            body["attendees"] = [{"email": attendee} for attendee in attendees]
        if not body:
            return "Error: no event fields were provided to update"

        params = {"calendarId": calendar_id or "primary", "eventId": event_id}
        payload, error = await self._backend.run_json(
            "calendar",
            "events",
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
            return f"Updated event {event_id} on {calendar_id or 'primary'}."
        return (
            f"Updated event: {payload.get('summary') or '(untitled)'} "
            f"[{payload.get('id', event_id)}] "
            f"{_format_event_time(payload.get('start'))} -> {_format_event_time(payload.get('end'))} "
            f"({payload.get('status', 'confirmed')})"
        )


@tool_parameters(
    tool_parameters_schema(
        event_id=StringSchema("Google Calendar event ID"),
        calendar_id=StringSchema("Calendar ID", nullable=True),
        required=["event_id"],
    )
)
class GWSCalendarDeleteEventTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_delete_event"

    @property
    def description(self) -> str:
        return "Delete a Google Calendar event."

    @property
    def approval_family(self) -> str | None:
        return "calendar_write"

    def approval_scope_key(self, params: dict[str, Any]) -> str | None:
        return f"{self.name}:{params.get('calendar_id') or 'primary'}"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        return (
            f"Delete Google Calendar event {params.get('event_id')} from "
            f"{params.get('calendar_id') or 'primary'}."
        )

    async def execute(self, event_id: str, calendar_id: str | None = None, **kwargs: Any) -> str:
        params = {"calendarId": calendar_id or "primary", "eventId": event_id}
        payload, error = await self._backend.run_json(
            "calendar",
            "events",
            "delete",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        _ = payload
        return f"Deleted event {event_id} from {calendar_id or 'primary'}."


@tool_parameters(
    tool_parameters_schema(
        calendar_id=StringSchema("Calendar ID", nullable=True),
        sync_token=StringSchema("Calendar sync token for delta fetches", nullable=True),
        time_min=StringSchema("Optional RFC3339/ISO lower time bound", nullable=True),
        time_max=StringSchema("Optional RFC3339/ISO upper time bound", nullable=True),
        max_results=IntegerSchema(
            description="Maximum changes to return",
            minimum=1,
            maximum=2500,
            nullable=True,
        ),
        include_deleted=BooleanSchema(description="Include deleted events", default=False),
    )
)
class GWSCalendarListEventChangesTool(_CalendarTool):
    @property
    def name(self) -> str:
        return "mcp_gws_calendar_list_event_changes"

    @property
    def description(self) -> str:
        return "List Google Calendar event changes in a machine-oriented delta format."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def approval_family(self) -> str | None:
        return "calendar_read"

    def build_approval_preview(self, params: dict[str, Any]) -> str:
        calendar_id = params.get("calendar_id") or "primary"
        if params.get("sync_token"):
            return f"Read Google Calendar changes on {calendar_id} using a sync token."
        return f"Read Google Calendar changes on {calendar_id} in the requested window."

    async def execute(
        self,
        calendar_id: str | None = None,
        sync_token: str | None = None,
        time_min: str | None = None,
        time_max: str | None = None,
        max_results: int | None = None,
        include_deleted: bool = False,
        **kwargs: Any,
    ) -> str:
        params: dict[str, Any] = {
            "calendarId": calendar_id or "primary",
            "showDeleted": include_deleted,
        }
        if sync_token:
            params["syncToken"] = sync_token
        if time_min:
            params["timeMin"] = time_min
        if time_max:
            params["timeMax"] = time_max
        if max_results is not None:
            params["maxResults"] = max_results

        payload, error = await self._backend.run_json(
            "calendar",
            "events",
            "list",
            "--params",
            json.dumps(params, ensure_ascii=False),
            "--format",
            "json",
        )
        if error:
            return error
        if not isinstance(payload, dict):
            return _compact_json(
                {
                    "calendar_id": calendar_id or "primary",
                    "items": [],
                    "next_sync_token": None,
                    "result_count": 0,
                    "sync_token_used": sync_token,
                }
            )

        items = payload.get("items", [])
        compact_items: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            compact_items.append(
                {
                    "deleted": item.get("status") == "cancelled",
                    "end": _format_event_time(item.get("end")),
                    "id": item.get("id"),
                    "start": _format_event_time(item.get("start")),
                    "status": item.get("status"),
                    "summary": item.get("summary"),
                    "updated": item.get("updated"),
                }
            )

        return _compact_json(
            {
                "calendar_id": calendar_id or "primary",
                "items": compact_items,
                "next_sync_token": payload.get("nextSyncToken"),
                "result_count": len(compact_items),
                "sync_token_used": sync_token,
                "time_max_used": time_max,
                "time_min_used": time_min,
            }
        )


def build_gws_calendar_tools(config: Any, *, timezone: str = "UTC") -> list[Tool]:
    """Create the built-in gws-backed calendar suite."""
    backend = GWSCalendarRunner(command=config.command, timeout=config.timeout)
    return [
        GWSCalendarAgendaTool(backend),
        GWSCalendarListCalendarsTool(backend),
        GWSCalendarListEventsTool(backend),
        GWSCalendarGetEventTool(backend),
        GWSCalendarFindFreeTimeTool(backend),
        GWSCalendarCreateEventTool(backend),
        GWSCalendarUpdateEventTool(backend),
        GWSCalendarDeleteEventTool(backend),
        GWSCalendarListEventChangesTool(backend),
    ]
