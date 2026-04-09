from __future__ import annotations

from nanobot.bus.events import InboundMessage, OutboundMessage
from nanobot.command.router import CommandContext, CommandRouter


async def _echo_args(ctx: CommandContext) -> OutboundMessage:
    return OutboundMessage(channel=ctx.msg.channel, chat_id=ctx.msg.chat_id, content=ctx.args)


def _make_ctx(raw: str) -> CommandContext:
    msg = InboundMessage(channel="telegram", sender_id="u1", chat_id="c1", content=raw)
    return CommandContext(msg=msg, session=None, key=msg.session_key, raw=raw)


async def test_priority_prefix_is_detected() -> None:
    router = CommandRouter()
    router.priority_prefix("/mode ", _echo_args)

    assert router.is_priority("/mode scheduler") is True


async def test_priority_prefix_dispatch_sets_args() -> None:
    router = CommandRouter()
    router.priority("/mode", _echo_args)
    router.priority_prefix("/mode ", _echo_args)

    out = await router.dispatch_priority(_make_ctx("/mode scheduler"))

    assert out is not None
    assert out.content == "scheduler"
