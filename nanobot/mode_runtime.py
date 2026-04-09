"""Per-mode runtime bundles for the main agent loop."""

from __future__ import annotations

from dataclasses import dataclass

from nanobot.agent.context import ContextBuilder
from nanobot.agent.memory import Consolidator, Dream
from nanobot.agent.subagent import SubagentManager
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.cron.service import CronService
from nanobot.session.manager import SessionManager


@dataclass(slots=True)
class ModeRuntime:
    """Everything the agent loop needs for one active mode."""

    mode: str
    workspace: object
    context: ContextBuilder
    sessions: SessionManager
    tools: ToolRegistry
    subagents: SubagentManager
    consolidator: Consolidator
    dream: Dream
    cron_service: CronService | None = None
