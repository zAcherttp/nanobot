"""Scheduler-local file state for observations, external diffs, and sync cursors."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_MAX_SEEN_CHANGE_KEYS = 500


def memory_dir(workspace: Path) -> Path:
    return workspace / "memory"


def observations_path(workspace: Path) -> Path:
    return memory_dir(workspace) / "observations.jsonl"


def diff_insights_path(workspace: Path) -> Path:
    return memory_dir(workspace) / "diff_insights.jsonl"


def sync_state_path(workspace: Path) -> Path:
    return memory_dir(workspace) / "sync_state.json"


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
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
    return items


def read_jsonl_tail(path: Path, limit: int) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    items = read_jsonl(path)
    return items[-limit:]


def next_cursor(path: Path) -> int:
    items = read_jsonl_tail(path, 1)
    if not items:
        return 1
    last = items[-1].get("cursor")
    return int(last) + 1 if isinstance(last, int) else 1


def append_jsonl(path: Path, payload: dict[str, Any]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    cursor = next_cursor(path)
    entry = {"cursor": cursor, **payload}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return cursor


def load_sync_state(workspace: Path) -> dict[str, Any]:
    path = sync_state_path(workspace)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("sources", {})
    payload.setdefault("dream", {})
    return payload


def save_sync_state(workspace: Path, payload: dict[str, Any]) -> None:
    path = sync_state_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _normalize_title(item: dict[str, Any]) -> str:
    for key in ("summary", "title", "name"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return str(item.get("id") or "unknown")


def _calendar_when(item: dict[str, Any]) -> str | None:
    start = item.get("start")
    if isinstance(start, dict):
        for key in ("dateTime", "date"):
            value = start.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for key in ("start", "due", "updated"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def summarize_external_change(source: str, item: dict[str, Any]) -> tuple[str, str]:
    """Return (kind, summary) for one external delta item."""

    title = _normalize_title(item)
    deleted = bool(item.get("deleted"))
    status = str(item.get("status") or "").lower()
    when = _calendar_when(item)

    if source == "calendar":
        if deleted or status == "cancelled":
            return "calendar_removed", f"Calendar event '{title}' was removed."
        if when:
            return "calendar_changed", f"Calendar event '{title}' now appears at {when}."
        return "calendar_changed", f"Calendar event '{title}' was updated."

    if source == "tasks":
        if deleted:
            return "task_deleted", f"Task '{title}' was deleted."
        if status == "completed" or item.get("completed"):
            return "task_completed", f"Task '{title}' was marked completed."
        due = item.get("due")
        if isinstance(due, str) and due.strip():
            return "task_changed", f"Task '{title}' is due {due.strip()}."
        return "task_changed", f"Task '{title}' was updated."

    return f"{source}_change", f"{source.title()} item '{title}' was updated."


def build_change_key(source: str, item: dict[str, Any]) -> str:
    stable = {
        "id": item.get("id"),
        "updated": item.get("updated"),
        "etag": item.get("etag"),
        "status": item.get("status"),
        "deleted": item.get("deleted"),
        "start": item.get("start"),
        "end": item.get("end"),
        "due": item.get("due"),
        "completed": item.get("completed"),
    }
    digest = hashlib.sha1(
        json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:12]
    return f"{source}:{item.get('id') or 'unknown'}:{digest}"


def reconcile_external_changes(
    workspace: Path,
    *,
    source: str,
    changes: list[dict[str, Any]] | None = None,
    cursor: dict[str, Any] | None = None,
    scope: str | None = None,
    max_insights: int = 20,
) -> dict[str, Any]:
    """Persist compact diff insights and update sync-state cursors."""

    changes = [item for item in (changes or []) if isinstance(item, dict)]
    state = load_sync_state(workspace)
    sources = state.setdefault("sources", {})
    source_state = sources.setdefault(source, {})
    seen = list(source_state.get("seen_change_keys") or [])
    seen_set = set(str(item) for item in seen)

    recorded = 0
    skipped = 0
    latest_cursor = 0
    diff_path = diff_insights_path(workspace)

    for item in changes[: max(1, max_insights)]:
        change_key = build_change_key(source, item)
        if change_key in seen_set:
            skipped += 1
            continue
        kind, summary = summarize_external_change(source, item)
        latest_cursor = append_jsonl(
            diff_path,
            {
                "timestamp": utc_now_iso(),
                "source": source,
                "scope": scope,
                "kind": kind,
                "summary": summary,
                "entity_id": item.get("id"),
                "updated_at": item.get("updated"),
                "change_key": change_key,
            },
        )
        recorded += 1
        seen.append(change_key)
        seen_set.add(change_key)

    if cursor:
        cleaned_cursor = {
            str(key): value
            for key, value in cursor.items()
            if value not in (None, "", [], {})
        }
        if cleaned_cursor:
            source_state["cursor"] = cleaned_cursor
    source_state["last_reconciled_at"] = utc_now_iso()
    source_state["seen_change_keys"] = seen[-_MAX_SEEN_CHANGE_KEYS:]
    if latest_cursor:
        source_state["last_diff_cursor"] = latest_cursor
    save_sync_state(workspace, state)

    return {
        "diff_insights_path": "memory/diff_insights.jsonl",
        "latest_diff_cursor": latest_cursor or source_state.get("last_diff_cursor"),
        "recorded_count": recorded,
        "skipped_count": skipped,
        "source": source,
        "sync_state_path": "memory/sync_state.json",
        "sync_state": source_state,
    }


def replace_markdown_section(content: str, heading: str, body: str) -> str:
    """Replace or append a managed markdown section by heading."""

    normalized_body = body.strip() or "(none)"
    section = f"## {heading}\n\n{normalized_body}\n"
    pattern = re.compile(
        rf"(?ms)^## {re.escape(heading)}\n.*?(?=^## |\Z)"
    )
    if pattern.search(content):
        updated = pattern.sub(section, content)
    else:
        base = content.rstrip()
        updated = f"{base}\n\n{section}" if base else section
    return updated.strip() + "\n"
