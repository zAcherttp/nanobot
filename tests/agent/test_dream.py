"""Tests for the Dream class — two-phase memory consolidation via AgentRunner."""

import pytest

from unittest.mock import AsyncMock, MagicMock

from nanobot.agent.memory import Dream, MemoryStore
from nanobot.agent.runner import AgentRunResult


@pytest.fixture
def store(tmp_path):
    s = MemoryStore(tmp_path)
    s.write_soul("# Soul\n- Helpful")
    s.write_user("# User\n- Developer")
    s.write_memory("# Memory\n- Project X active")
    return s


@pytest.fixture
def mock_provider():
    p = MagicMock()
    p.chat_with_retry = AsyncMock()
    return p


@pytest.fixture
def mock_runner():
    return MagicMock()


@pytest.fixture
def dream(store, mock_provider, mock_runner):
    d = Dream(store=store, provider=mock_provider, model="test-model", max_batch_size=5)
    d._runner = mock_runner
    return d


def _make_run_result(
    stop_reason="completed",
    final_content=None,
    tool_events=None,
    usage=None,
):
    return AgentRunResult(
        final_content=final_content or stop_reason,
        stop_reason=stop_reason,
        messages=[],
        tools_used=[],
        usage={},
        tool_events=tool_events or [],
    )


class TestDreamRun:
    async def test_noop_when_no_unprocessed_history(self, dream, mock_provider, mock_runner, store):
        """Dream should not call LLM when there's nothing to process."""
        result = await dream.run()
        assert result is False
        mock_provider.chat_with_retry.assert_not_called()
        mock_runner.run.assert_not_called()

    async def test_calls_runner_for_unprocessed_entries(
        self, dream, mock_provider, mock_runner, store
    ):
        """Dream should call AgentRunner when there are unprocessed history entries."""
        store.append_history("User prefers dark mode")
        mock_provider.chat_with_retry.return_value = MagicMock(content="New fact")
        mock_runner.run = AsyncMock(
            return_value=_make_run_result(
                tool_events=[{"name": "edit_file", "status": "ok", "detail": "memory/MEMORY.md"}],
            )
        )
        result = await dream.run()
        assert result is True
        mock_runner.run.assert_called_once()
        spec = mock_runner.run.call_args[0][0]
        assert spec.max_iterations == 10
        assert spec.fail_on_tool_error is False

    async def test_advances_dream_cursor(self, dream, mock_provider, mock_runner, store):
        """Dream should advance the cursor after processing."""
        store.append_history("event 1")
        store.append_history("event 2")
        mock_provider.chat_with_retry.return_value = MagicMock(content="Nothing new")
        mock_runner.run = AsyncMock(return_value=_make_run_result())
        await dream.run()
        assert store.get_last_dream_cursor() == 2

    async def test_compacts_processed_history(self, dream, mock_provider, mock_runner, store):
        """Dream should compact history after processing."""
        store.append_history("event 1")
        store.append_history("event 2")
        store.append_history("event 3")
        mock_provider.chat_with_retry.return_value = MagicMock(content="Nothing new")
        mock_runner.run = AsyncMock(return_value=_make_run_result())
        await dream.run()
        # After Dream, cursor is advanced and 3, compact keeps last max_history_entries
        entries = store.read_unprocessed_history(since_cursor=0)
        assert all(e["cursor"] > 0 for e in entries)

    async def test_scheduler_audit_promotes_repeated_behavior_as_low_confidence_hypothesis(
        self, tmp_path, mock_provider, mock_runner
    ):
        store = MemoryStore(tmp_path)
        (tmp_path / "USER.md").write_text(
            "# Behavioral Profile\n\n## Signals\n\n(none)\n\n## Learned Hypotheses\n\n(none yet)\n",
            encoding="utf-8",
        )
        (tmp_path / "GOALS.md").write_text(
            "# Active Goals\n\n## Recent External Changes\n\n(none yet)\n",
            encoding="utf-8",
        )
        (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
        (tmp_path / "memory" / "observations.jsonl").write_text(
            "\n".join(
                [
                    '{"cursor":1,"timestamp":"2026-04-10T01:00:00Z","summary":"Afternoon admin keeps getting deferred","kind":"pattern","source":"chat"}',
                    '{"cursor":2,"timestamp":"2026-04-11T01:00:00Z","summary":"Afternoon admin keeps getting deferred","kind":"pattern","source":"chat"}',
                ]
            ),
            encoding="utf-8",
        )
        dream = Dream(store=store, provider=mock_provider, model="test-model", mode="scheduler")
        dream._runner = mock_runner

        result = await dream.run()

        assert result is True
        assert "Low confidence: Afternoon admin keeps getting deferred" in store.read_user()
        mock_provider.chat_with_retry.assert_not_called()
        mock_runner.run.assert_not_called()

    async def test_scheduler_audit_updates_goals_from_reconciled_external_changes(
        self, tmp_path, mock_provider, mock_runner
    ):
        store = MemoryStore(tmp_path)
        (tmp_path / "USER.md").write_text("# Behavioral Profile\n", encoding="utf-8")
        (tmp_path / "GOALS.md").write_text(
            "# Active Goals\n\n## Recent External Changes\n\n(none yet)\n",
            encoding="utf-8",
        )
        (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
        (tmp_path / "memory" / "diff_insights.jsonl").write_text(
            '{"cursor":1,"timestamp":"2026-04-10T02:00:00Z","summary":"Calendar event \'Review\' now appears at 2026-04-12T09:00:00+07:00.","source":"calendar"}\n',
            encoding="utf-8",
        )
        dream = Dream(store=store, provider=mock_provider, model="test-model", mode="scheduler")
        dream._runner = mock_runner

        result = await dream.run()

        assert result is True
        assert "Calendar event 'Review' now appears at 2026-04-12T09:00:00+07:00." in (
            (tmp_path / "GOALS.md").read_text(encoding="utf-8")
        )
