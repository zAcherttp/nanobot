from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanobot.agent.scheduler_contract import PlannerDecision, parse_planner_decision
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.cron.service import CronService


def _make_loop(tmp_path: Path, *, with_scheduler_cron: bool = False):
    from nanobot.agent.loop import AgentLoop

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 1024

    cron_services = {}
    if with_scheduler_cron:
        cron_services["scheduler"] = CronService(tmp_path / "scheduler" / "cron" / "jobs.json")

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
            cron_services=cron_services,
        )
    return loop, fake_session


def test_parse_planner_decision_strips_trailing_tag() -> None:
    visible, decision = parse_planner_decision(
        "Ask me before I move the review block.\n\n"
        '<planner_decision>{"status":"needs_approval","summary":"Need approval to move the review block","proposed_changes":["Move review to Thursday"],"approval_family":"timespan_apply","follow_up_at":null,"blockers":[]}</planner_decision>'
    )

    assert visible == "Ask me before I move the review block."
    assert decision is not None
    assert decision.status == "needs_approval"
    assert decision.approval_family == "timespan_apply"
    assert list(decision.proposed_changes) == ["Move review to Thursday"]


def test_parse_planner_decision_reads_proposal_bundle() -> None:
    visible, decision = parse_planner_decision(
        "I can move the writing block.\n\n"
        '<planner_decision>{"status":"needs_approval","summary":"Need approval to move the writing block","proposed_changes":["Move writing block to tomorrow morning"],"approval_family":"timespan_apply","follow_up_at":null,"blockers":[],"proposal_bundle":{"bundle_id":"bundle-1","summary":"Move writing block","approval_family":"timespan_apply","operations":[{"id":"op-1","tool_name":"mcp_gws_calendar_update_event","params":{"event_id":"evt-1","start_time":"2026-04-11T09:00:00+07:00","end_time":"2026-04-11T10:00:00+07:00"},"summary":"Move the writing block","depends_on":[]}],"expected_side_effects":["Calendar event will move"],"rollback_guidance":"Move the event back if needed."}}</planner_decision>'
    )

    assert visible == "I can move the writing block."
    assert decision is not None
    assert decision.proposal_bundle is not None
    assert decision.proposal_bundle.bundle_id == "bundle-1"
    assert decision.proposal_bundle.operations[0].tool_name == "mcp_gws_calendar_update_event"


@pytest.mark.asyncio
async def test_apply_scheduler_contract_rewrites_visible_content(tmp_path: Path) -> None:
    from nanobot.agent.loop import _LoopRunResult

    loop, _ = _make_loop(tmp_path)
    runtime = loop._runtime_for_mode("scheduler")
    raw = (
        "I can move the writing block to tomorrow morning.\n\n"
        '<planner_decision>{"status":"needs_approval","summary":"Need approval to move the writing block","proposed_changes":["Move writing block to tomorrow morning"],"approval_family":"timespan_apply","follow_up_at":null,"blockers":[]}</planner_decision>'
    )
    result = _LoopRunResult(
        final_content=raw,
        tools_used=[],
        messages=[{"role": "assistant", "content": raw}],
        stop_reason="completed",
    )

    updated = await loop._apply_scheduler_contract(
        runtime,
        result,
        channel="telegram",
        chat_id="chat",
    )

    assert updated.final_content == "I can move the writing block to tomorrow morning."
    assert updated.planner_decision is not None
    assert updated.planner_decision.status == "needs_approval"
    assert updated.messages[-1]["content"] == updated.final_content


@pytest.mark.asyncio
async def test_apply_scheduler_contract_creates_bundle_approval_request(tmp_path: Path) -> None:
    from nanobot.agent.loop import _LoopRunResult

    loop, _ = _make_loop(tmp_path)
    runtime = loop._runtime_for_mode("scheduler")
    raw = (
        "I can move the writing block to tomorrow morning.\n\n"
        '<planner_decision>{"status":"needs_approval","summary":"Need approval to move the writing block","proposed_changes":["Move writing block to tomorrow morning"],"approval_family":"timespan_apply","follow_up_at":null,"blockers":[],"proposal_bundle":{"bundle_id":"bundle-1","summary":"Move writing block","approval_family":"timespan_apply","operations":[{"id":"op-1","tool_name":"mcp_gws_calendar_update_event","params":{"event_id":"evt-1","start_time":"2026-04-11T09:00:00+07:00","end_time":"2026-04-11T10:00:00+07:00"},"summary":"Move the writing block","depends_on":[]}],"expected_side_effects":["Calendar event will move"],"rollback_guidance":"Move the event back if needed."}}</planner_decision>'
    )
    result = _LoopRunResult(
        final_content=raw,
        tools_used=[],
        messages=[{"role": "assistant", "content": raw}],
        stop_reason="completed",
    )

    updated = await loop._apply_scheduler_contract(
        runtime,
        result,
        channel="telegram",
        chat_id="chat",
    )

    assert updated.stop_reason == "approval_pending"
    assert updated.approval_request is not None
    assert updated.approval_request.tool_name == "scheduler_apply_proposal_bundle"
    assert updated.approval_request.approval_family == "timespan_apply"


@pytest.mark.asyncio
async def test_schedule_followup_decision_creates_one_off_cron_job(tmp_path: Path) -> None:
    from nanobot.agent.loop import _LoopRunResult

    loop, _ = _make_loop(tmp_path, with_scheduler_cron=True)
    runtime = loop._runtime_for_mode("scheduler")
    raw = (
        "I will check back with you later today.\n\n"
        '<planner_decision>{"status":"schedule_followup","summary":"Check whether the draft block was completed","proposed_changes":["Follow up after the draft window"],"approval_family":null,"follow_up_at":"2026-02-24T17:30:00+07:00","blockers":[]}</planner_decision>'
    )
    result = _LoopRunResult(
        final_content=raw,
        tools_used=[],
        messages=[{"role": "assistant", "content": raw}],
        stop_reason="completed",
    )

    updated = await loop._apply_scheduler_contract(
        runtime,
        result,
        channel="telegram",
        chat_id="chat",
    )

    jobs = runtime.cron_service.list_jobs() if runtime.cron_service else []
    assert len(jobs) == 1
    assert jobs[0].payload.channel == "telegram"
    assert jobs[0].payload.to == "chat"
    assert jobs[0].payload.mode == "scheduler"
    assert "Follow-up scheduled for" in (updated.final_content or "")


@pytest.mark.asyncio
async def test_process_message_propagates_planner_metadata(tmp_path: Path) -> None:
    from nanobot.agent.loop import _LoopRunResult

    loop, _ = _make_loop(tmp_path)
    loop._run_agent_loop = AsyncMock(
        return_value=_LoopRunResult(
            final_content="I need your approval before I move the task block.",
            tools_used=[],
            messages=[{"role": "assistant", "content": "I need your approval before I move the task block."}],
            stop_reason="completed",
            planner_decision=PlannerDecision(
                status="needs_approval",
                summary="Need approval before moving the task block",
                proposed_changes=("Move the task block to tomorrow morning",),
                approval_family="timespan_apply",
            ),
        )
    )

    response = await loop._process_message(
        InboundMessage(channel="telegram", sender_id="u1", chat_id="chat", content="reschedule it"),
        session_key="telegram:chat",
        mode="scheduler",
    )

    assert response is not None
    assert response.metadata["_planner_status"] == "needs_approval"
    assert response.metadata["_planner_approval_family"] == "timespan_apply"


@pytest.mark.asyncio
async def test_process_message_propagates_done_status(tmp_path: Path) -> None:
    from nanobot.agent.loop import _LoopRunResult

    loop, _ = _make_loop(tmp_path)
    loop._run_agent_loop = AsyncMock(
        return_value=_LoopRunResult(
            final_content="The task block already fits your schedule.",
            tools_used=[],
            messages=[{"role": "assistant", "content": "The task block already fits your schedule."}],
            stop_reason="completed",
            planner_decision=PlannerDecision(
                status="done",
                summary="No further action needed",
            ),
        )
    )

    response = await loop._process_message(
        InboundMessage(channel="telegram", sender_id="u1", chat_id="chat", content="is this okay?"),
        session_key="telegram:chat",
        mode="scheduler",
    )

    assert response is not None
    assert response.metadata["_planner_status"] == "done"
