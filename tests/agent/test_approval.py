from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.approval import ApprovalContext
from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import StringSchema, tool_parameters_schema
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.config.schema import ToolPermissionsConfig


@tool_parameters(tool_parameters_schema(summary=StringSchema("Title"), required=["summary"]))
class _FakeApprovalTool(Tool):
    @property
    def name(self) -> str:
        return "calendar_write_test"

    @property
    def description(self) -> str:
        return "fake write tool"

    @property
    def approval_family(self) -> str | None:
        return "calendar_write"

    def build_approval_preview(self, params: dict[str, str]) -> str:
        return f"Create event '{params['summary']}'."

    async def execute(self, **kwargs):
        return f"created {kwargs['summary']}"


@pytest.mark.asyncio
async def test_approval_manager_defaults_to_deny_when_policy_missing(tmp_path: Path) -> None:
    from nanobot.approval import ApprovalManager

    manager = ApprovalManager(tmp_path, default_policy=None, tool_policies={})
    ctx = ApprovalContext(
        mode="scheduler",
        session_key="telegram:1",
        conversation_key="telegram:1",
        channel="telegram",
        chat_id="1",
    )

    outcome = manager.evaluate_tool_call(
        tool_name="calendar_write_test",
        approval_family="calendar_write",
        approval_scope_key="calendar_write_test:primary",
        params={"summary": "Review"},
        preview="Create event 'Review'.",
        context=ctx,
    )

    assert outcome.policy == "deny"
    assert "denied" in (outcome.error or "").lower()


def _make_loop(tmp_path: Path, *, permissions: ToolPermissionsConfig | None = None):
    from nanobot.agent.loop import AgentLoop

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 1024

    fake_session = SimpleNamespace(
        key="telegram:chat",
        messages=[],
        metadata={},
        last_consolidated=0,
        get_history=lambda max_messages=0: [],
    )

    with (
        patch("nanobot.agent.loop.ContextBuilder") as mock_context_builder,
        patch("nanobot.agent.loop.SessionManager") as mock_session_manager,
        patch("nanobot.agent.loop.SubagentManager") as mock_subagents,
    ):
        context = MagicMock()
        context.timezone = "Asia/Saigon"
        context.memory = MagicMock()
        context.build_messages.return_value = [{"role": "user", "content": "hi"}]
        mock_context_builder.return_value = context

        sessions = MagicMock()
        sessions.get_or_create.return_value = fake_session
        mock_session_manager.return_value = sessions

        mock_subagents.return_value.cancel_by_session = AsyncMock(return_value=0)

        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=tmp_path,
            model="test-model",
            tool_permissions_config=permissions or ToolPermissionsConfig(),
        )
    return loop, fake_session


@pytest.mark.asyncio
async def test_process_message_returns_approval_prompt_when_runner_stops_for_approval(
    tmp_path: Path,
) -> None:
    from nanobot.agent.loop import _LoopRunResult
    from nanobot.approval import ApprovalRequest

    loop, session = _make_loop(tmp_path)
    request = ApprovalRequest(
        id="req1",
        tool_name="mcp_gws_calendar_create_event",
        approval_family="calendar_write",
        approval_scope_key="mcp_gws_calendar_create_event:primary",
        mode="scheduler",
        conversation_key="telegram:chat",
        session_key="telegram:chat",
        channel="telegram",
        chat_id="chat",
        message_thread_id=None,
        request_message_id=99,
        params={"summary": "Review"},
        preview="Create event 'Review'.",
        status="pending",
        created_at_ms=1,
        updated_at_ms=1,
        expires_at_ms=9999999999999,
    )
    loop._run_agent_loop = AsyncMock(
        return_value=_LoopRunResult(
            final_content=None,
            tools_used=["mcp_gws_calendar_create_event"],
            messages=[{"role": "assistant", "content": ""}],
            stop_reason="approval_pending",
            approval_request=request,
        )
    )

    response = await loop._process_message(
        InboundMessage(channel="telegram", sender_id="u1", chat_id="chat", content="book it"),
        session_key="telegram:chat",
        mode="scheduler",
    )

    assert response is not None
    assert "Approval required" in response.content
    assert response.metadata["actions"][0]["action"] == "approve_once"
    assert session.messages == []


@pytest.mark.asyncio
async def test_text_approval_executes_pending_request_directly(tmp_path: Path) -> None:
    loop, _ = _make_loop(
        tmp_path,
        permissions=ToolPermissionsConfig(tools={"calendar_write_test": "ask"}),
    )
    runtime = loop._runtime_for_mode("scheduler")
    runtime.tools.register(_FakeApprovalTool())
    request = loop.approvals.create_request(
        tool_name="calendar_write_test",
        approval_family="calendar_write",
        approval_scope_key="calendar_write_test:primary",
        params={"summary": "Thesis Review"},
        preview="Create event 'Thesis Review'.",
        context=ApprovalContext(
            mode="scheduler",
            session_key="telegram:chat",
            conversation_key="telegram:chat",
            channel="telegram",
            chat_id="chat",
            request_message_id=11,
        ),
    )

    handled, rewritten, outbound = await loop._maybe_handle_approval_message(
        InboundMessage(channel="telegram", sender_id="u1", chat_id="chat", content="approve")
    )

    assert handled is True
    assert rewritten is None
    assert outbound is not None
    assert "Approved and executed." in outbound.content
    assert "created Thesis Review" in outbound.content
    assert loop.approvals.get_request(request.id).status == "approved"


@pytest.mark.asyncio
async def test_reply_revision_supersedes_pending_request_and_rewrites_message(tmp_path: Path) -> None:
    loop, _ = _make_loop(
        tmp_path,
        permissions=ToolPermissionsConfig(tools={"calendar_write_test": "ask"}),
    )
    request = loop.approvals.create_request(
        tool_name="calendar_write_test",
        approval_family="calendar_write",
        approval_scope_key="calendar_write_test:primary",
        params={"summary": "Thesis Review"},
        preview="Create event 'Thesis Review'.",
        context=ApprovalContext(
            mode="scheduler",
            session_key="telegram:chat",
            conversation_key="telegram:chat",
            channel="telegram",
            chat_id="chat",
            request_message_id=55,
        ),
    )

    handled, rewritten, outbound = await loop._maybe_handle_approval_message(
        InboundMessage(
            channel="telegram",
            sender_id="u1",
            chat_id="chat",
            content="make it 30 minutes later",
            metadata={"reply_to_message_id": 55},
        )
    )

    assert handled is False
    assert outbound is None
    assert rewritten is not None
    assert "revising a pending approval request" in rewritten.content
    assert loop.approvals.get_request(request.id).status == "superseded"


@pytest.mark.asyncio
async def test_always_allow_grant_suppresses_future_prompts(tmp_path: Path) -> None:
    from nanobot.approval import ApprovalManager

    manager = ApprovalManager(
        tmp_path,
        tool_policies={"calendar_write_test": "ask"},
    )
    ctx = ApprovalContext(
        mode="scheduler",
        session_key="telegram:chat",
        conversation_key="telegram:chat",
        channel="telegram",
        chat_id="chat",
    )
    request = manager.create_request(
        tool_name="calendar_write_test",
        approval_family="calendar_write",
        approval_scope_key="calendar_write_test:primary",
        params={"summary": "Review"},
        preview="Create event 'Review'.",
        context=ctx,
    )
    manager.add_grant(request)

    outcome = manager.evaluate_tool_call(
        tool_name="calendar_write_test",
        approval_family="calendar_write",
        approval_scope_key="calendar_write_test:primary",
        params={"summary": "Review 2"},
        preview="Create event 'Review 2'.",
        context=ctx,
    )

    assert outcome.policy == "allow"
    assert outcome.request is None


def test_default_permissions_include_calendar_and_tasks_scheduler_tools() -> None:
    permissions = ToolPermissionsConfig()

    assert permissions.tools["mcp_gws_calendar_list_event_changes"] == "allow"
    assert permissions.tools["mcp_gws_calendar_update_event"] == "ask"
    assert permissions.tools["mcp_gws_tasks_list_tasks"] == "allow"
    assert permissions.tools["mcp_gws_tasks_create_task"] == "ask"


def test_default_permissions_allow_task_reads_and_request_task_write_approval(tmp_path: Path) -> None:
    from nanobot.approval import ApprovalManager

    manager = ApprovalManager(tmp_path, tool_policies=ToolPermissionsConfig().tools)
    ctx = ApprovalContext(
        mode="scheduler",
        session_key="telegram:chat",
        conversation_key="telegram:chat",
        channel="telegram",
        chat_id="chat",
    )

    read_outcome = manager.evaluate_tool_call(
        tool_name="mcp_gws_tasks_list_tasks",
        approval_family="task_read",
        approval_scope_key="mcp_gws_tasks_list_tasks:@default",
        params={"tasklist_id": "@default"},
        preview="List tasks.",
        context=ctx,
    )
    write_outcome = manager.evaluate_tool_call(
        tool_name="mcp_gws_tasks_create_task",
        approval_family="task_write",
        approval_scope_key="mcp_gws_tasks_create_task:@default",
        params={"title": "Write chapter"},
        preview="Create task 'Write chapter'.",
        context=ctx,
    )

    assert read_outcome.policy == "allow"
    assert read_outcome.request is None
    assert write_outcome.policy == "ask"
    assert write_outcome.request is not None
