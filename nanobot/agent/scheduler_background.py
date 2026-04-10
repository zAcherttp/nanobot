"""Scheduler-mode background sync and reflection helpers."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from nanobot.agent.scheduler_state import (
    load_sync_state,
    observations_path,
    read_jsonl_tail,
    read_text,
    save_sync_state,
    utc_now_iso,
)
from nanobot.mode_runtime import ModeRuntime

_DEFAULT_LOOKBACK_DAYS = 7
_DEFAULT_MORNING_END_HOUR = 12
_DEFAULT_NIGHT_END_HOUR = 21


def _parse_compact_json(text: str) -> dict[str, Any] | None:
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _phase_label(phase: str) -> str:
    return "morning" if phase == "morning_end" else "day"


def _extract_hour(value: Any) -> int | None:
    if isinstance(value, int):
        return value if 0 <= value <= 23 else None
    if not isinstance(value, str):
        return None
    match = re.search(r"\b([01]?\d|2[0-3])(?::([0-5]\d))?\b", value)
    if not match:
        return None
    return int(match.group(1))


def _derived_phase_hours(runtime: ModeRuntime) -> dict[str, int]:
    user_text = read_text(runtime.workspace / "USER.md")
    observations = read_jsonl_tail(observations_path(runtime.workspace), 120)
    phase_hours = {
        "morning_end": _DEFAULT_MORNING_END_HOUR,
        "night_end": _DEFAULT_NIGHT_END_HOUR,
    }

    for key, phase in (
        ("morning_phase_end", "morning_end"),
        ("night_phase_end", "night_end"),
        ("workday_end", "night_end"),
    ):
        match = re.search(rf"{key}\s*[:=]\s*([^\n]+)", user_text, re.IGNORECASE)
        if match:
            hour = _extract_hour(match.group(1))
            if hour is not None:
                phase_hours[phase] = hour

    for item in observations:
        if not isinstance(item, dict):
            continue
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        phase = str(metadata.get("phase") or "")
        if phase in {"morning_end", "night_end"}:
            hour = _extract_hour(metadata.get("trigger_hour"))
            if hour is not None:
                phase_hours[phase] = hour
        if item.get("kind") in {"working_hours", "working_hours_signal", "workday_end"}:
            hour = _extract_hour(metadata.get("end_hour") or item.get("summary") or item.get("evidence"))
            if hour is not None:
                phase_hours["night_end"] = hour
    return phase_hours


def _now_in_timezone(timezone: str | None) -> datetime:
    return datetime.now(ZoneInfo(timezone or "UTC"))


def _default_time_min(now: datetime) -> str:
    return (now.astimezone(UTC) - timedelta(days=_DEFAULT_LOOKBACK_DAYS)).replace(
        microsecond=0
    ).isoformat().replace("+00:00", "Z")


async def run_scheduler_delta_sync(runtime: ModeRuntime) -> dict[str, Any]:
    """Fetch external deltas and reconcile them into local scheduler state."""

    state = load_sync_state(runtime.workspace)
    source_state = state.setdefault("sources", {})
    now = _now_in_timezone(runtime.context.timezone)
    summary: dict[str, Any] = {"calendar": None, "tasks": None}

    calendar_tool = runtime.tools.get("mcp_gws_calendar_list_event_changes")
    reconcile_tool = runtime.tools.get("scheduler_reconcile_external_changes")
    if calendar_tool is not None and reconcile_tool is not None:
        cursor = source_state.get("calendar", {}).get("cursor", {})
        params: dict[str, Any] = {
            "calendar_id": cursor.get("calendar_id") or "primary",
            "include_deleted": True,
        }
        if cursor.get("sync_token"):
            params["sync_token"] = cursor["sync_token"]
        else:
            params["time_min"] = (
                source_state.get("calendar", {}).get("last_reconciled_at")
                or _default_time_min(now)
            )
        payload = _parse_compact_json(await calendar_tool.execute(**params))
        if payload is not None:
            reconcile = await reconcile_tool.execute(
                source="calendar",
                scope=str(payload.get("calendar_id") or "primary"),
                cursor={
                    "calendar_id": str(payload.get("calendar_id") or "primary"),
                    "sync_token": payload.get("next_sync_token"),
                },
                changes=list(payload.get("items") or []),
            )
            summary["calendar"] = _parse_compact_json(reconcile)

    tasks_tool = runtime.tools.get("mcp_gws_tasks_list_task_changes")
    if tasks_tool is not None and reconcile_tool is not None:
        cursor = source_state.get("tasks", {}).get("cursor", {})
        params = {
            "tasklist_id": cursor.get("tasklist_id") or "@default",
            "show_completed": True,
            "show_hidden": True,
            "show_deleted": True,
        }
        if cursor.get("updated_min"):
            params["updated_min"] = cursor["updated_min"]
        else:
            params["updated_min"] = (
                source_state.get("tasks", {}).get("last_reconciled_at")
                or _default_time_min(now)
            )
        payload = _parse_compact_json(await tasks_tool.execute(**params))
        if payload is not None:
            reconcile = await reconcile_tool.execute(
                source="tasks",
                scope=str(payload.get("tasklist_id") or "@default"),
                cursor={
                    "tasklist_id": str(payload.get("tasklist_id") or "@default"),
                    "updated_min": payload.get("next_updated_min"),
                },
                changes=list(payload.get("items") or []),
            )
            summary["tasks"] = _parse_compact_json(reconcile)
    return summary


def _collect_flagged_items(runtime: ModeRuntime) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for observation in reversed(read_jsonl_tail(observations_path(runtime.workspace), 120)):
        if not isinstance(observation, dict):
            continue
        metadata = observation.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        if metadata.get("flag_for_followup") is True or observation.get("kind") in {
            "followup_flag",
            "flagged_task",
            "flagged_event",
        }:
            items.append(observation)
    return items


def _phase_templates(phase: str) -> str:
    if phase == "morning_end":
        return "How did your morning go? Did the main thing you planned actually get done?"
    return "How did the day end? What still needs to move, defer, or be protected for tomorrow?"


def _pick_reflection_messages(runtime: ModeRuntime) -> list[str]:
    state = load_sync_state(runtime.workspace)
    reflection_state = state.setdefault("reflection", {})
    sent = reflection_state.setdefault("sent", {})
    asked_entities = list(reflection_state.get("asked_entity_ids") or [])
    asked_set = set(str(item) for item in asked_entities)
    now = _now_in_timezone(runtime.context.timezone)
    phase_hours = _derived_phase_hours(runtime)
    messages: list[str] = []
    flagged_items = _collect_flagged_items(runtime)

    due_phases: list[str] = []
    for phase in ("morning_end", "night_end"):
        hour = phase_hours.get(phase, _DEFAULT_MORNING_END_HOUR if phase == "morning_end" else _DEFAULT_NIGHT_END_HOUR)
        if now.hour < hour:
            continue
        day_key = now.date().isoformat()
        if sent.get(phase) == day_key:
            continue
        due_phases.append(phase)

    for phase in due_phases[-1:]:
        day_key = now.date().isoformat()
        message = _phase_templates(phase)
        for item in flagged_items:
            linked_entities = item.get("linked_entities") or []
            entity_id = str(linked_entities[0]) if linked_entities else str(item.get("cursor") or "")
            if entity_id and entity_id in asked_set:
                continue
            title = str(item.get("summary") or item.get("title") or "").strip()
            if title:
                message = f"How did this {_phase_label(phase)} item go: {title}?"
            if entity_id:
                asked_entities.append(entity_id)
                asked_set.add(entity_id)
            break
        messages.append(message)
        sent[phase] = day_key

    reflection_state["sent"] = sent
    reflection_state["asked_entity_ids"] = asked_entities[-200:]
    reflection_state["last_reflection_at"] = utc_now_iso()
    save_sync_state(runtime.workspace, state)
    return messages


async def run_scheduler_reflection(runtime: ModeRuntime) -> list[str]:
    """Return any due deterministic phase-end reflection prompts."""

    return _pick_reflection_messages(runtime)
