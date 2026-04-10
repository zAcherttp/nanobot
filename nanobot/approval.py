"""Approval policies and persistent approval request storage."""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from nanobot.utils.helpers import ensure_dir

ApprovalPolicy = Literal["allow", "ask", "deny"]
ApprovalAction = Literal["approve_once", "approve_always", "deny"]
ApprovalStatus = Literal["pending", "approved", "denied", "expired", "superseded"]

_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(slots=True)
class ApprovalContext:
    """Conversation context needed to evaluate or execute approvals."""

    mode: str
    session_key: str
    conversation_key: str
    channel: str
    chat_id: str
    message_thread_id: int | None = None
    reply_to_message_id: int | None = None
    request_message_id: int | None = None


@dataclass(slots=True)
class ApprovalGrant:
    """Conversation-scoped approval grant."""

    conversation_key: str
    mode: str
    approval_scope_key: str
    created_at_ms: int
    updated_at_ms: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ApprovalGrant:
        return cls(
            conversation_key=str(data.get("conversationKey", "")),
            mode=str(data.get("mode", "")),
            approval_scope_key=str(data.get("approvalScopeKey", "")),
            created_at_ms=int(data.get("createdAtMs", 0)),
            updated_at_ms=int(data.get("updatedAtMs", 0)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "conversationKey": self.conversation_key,
            "mode": self.mode,
            "approvalScopeKey": self.approval_scope_key,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
        }


@dataclass(slots=True)
class ApprovalRequest:
    """Frozen request awaiting user approval."""

    id: str
    tool_name: str
    approval_family: str
    approval_scope_key: str
    mode: str
    conversation_key: str
    session_key: str
    channel: str
    chat_id: str
    message_thread_id: int | None
    request_message_id: int | None
    params: dict[str, Any]
    preview: str
    status: ApprovalStatus
    created_at_ms: int
    updated_at_ms: int
    expires_at_ms: int
    resolution_message: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ApprovalRequest:
        return cls(
            id=str(data.get("id", "")),
            tool_name=str(data.get("toolName", "")),
            approval_family=str(data.get("approvalFamily", "")),
            approval_scope_key=str(data.get("approvalScopeKey", "")),
            mode=str(data.get("mode", "")),
            conversation_key=str(data.get("conversationKey", "")),
            session_key=str(data.get("sessionKey", "")),
            channel=str(data.get("channel", "")),
            chat_id=str(data.get("chatId", "")),
            message_thread_id=data.get("messageThreadId"),
            request_message_id=data.get("requestMessageId"),
            params=dict(data.get("params", {})),
            preview=str(data.get("preview", "")),
            status=str(data.get("status", "pending")),
            created_at_ms=int(data.get("createdAtMs", 0)),
            updated_at_ms=int(data.get("updatedAtMs", 0)),
            expires_at_ms=int(data.get("expiresAtMs", 0)),
            resolution_message=data.get("resolutionMessage"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "toolName": self.tool_name,
            "approvalFamily": self.approval_family,
            "approvalScopeKey": self.approval_scope_key,
            "mode": self.mode,
            "conversationKey": self.conversation_key,
            "sessionKey": self.session_key,
            "channel": self.channel,
            "chatId": self.chat_id,
            "messageThreadId": self.message_thread_id,
            "requestMessageId": self.request_message_id,
            "params": self.params,
            "preview": self.preview,
            "status": self.status,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
            "expiresAtMs": self.expires_at_ms,
            "resolutionMessage": self.resolution_message,
        }

    def is_pending(self) -> bool:
        return self.status == "pending" and self.expires_at_ms > _now_ms()


@dataclass(slots=True)
class ApprovalOutcome:
    """Policy decision for one tool call."""

    policy: ApprovalPolicy
    request: ApprovalRequest | None = None
    error: str | None = None


class ApprovalPending(RuntimeError):
    """Raised by the runner when a tool call becomes a pending approval request."""

    def __init__(self, request: ApprovalRequest):
        super().__init__(f"Approval required for {request.tool_name}")
        self.request = request


class ApprovalManager:
    """Persist and resolve approval requests plus conversation-scoped grants."""

    def __init__(
        self,
        root_workspace: Path,
        *,
        default_policy: ApprovalPolicy | None = None,
        tool_policies: dict[str, ApprovalPolicy] | None = None,
        ttl_ms: int = _APPROVAL_TTL_MS,
    ):
        approval_dir = root_workspace / "approvals"
        self._requests_path = approval_dir / "requests.json"
        self._grants_path = approval_dir / "grants.json"
        self._requests_cache: dict[str, ApprovalRequest] | None = None
        self._grants_cache: list[ApprovalGrant] | None = None
        self._default_policy = default_policy or "deny"
        self._tool_policies = dict(tool_policies or {})
        self._ttl_ms = ttl_ms

    @property
    def default_policy(self) -> ApprovalPolicy:
        return self._default_policy

    def _load_requests(self) -> dict[str, ApprovalRequest]:
        if self._requests_cache is not None:
            return self._requests_cache
        try:
            raw = json.loads(self._requests_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, TypeError, json.JSONDecodeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        requests = {
            request_id: ApprovalRequest.from_dict(item)
            for request_id, item in raw.items()
            if isinstance(item, dict)
        }
        self._requests_cache = requests
        return requests

    def _save_requests(self) -> None:
        ensure_dir(self._requests_path.parent)
        data = {
            request_id: request.to_dict()
            for request_id, request in self._load_requests().items()
        }
        self._requests_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def _load_grants(self) -> list[ApprovalGrant]:
        if self._grants_cache is not None:
            return self._grants_cache
        try:
            raw = json.loads(self._grants_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, TypeError, json.JSONDecodeError):
            raw = []
        if not isinstance(raw, list):
            raw = []
        grants = [ApprovalGrant.from_dict(item) for item in raw if isinstance(item, dict)]
        self._grants_cache = grants
        return grants

    def _save_grants(self) -> None:
        ensure_dir(self._grants_path.parent)
        data = [grant.to_dict() for grant in self._load_grants()]
        self._grants_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def expire_requests(self) -> None:
        changed = False
        now_ms = _now_ms()
        for request in self._load_requests().values():
            if request.status == "pending" and request.expires_at_ms <= now_ms:
                request.status = "expired"
                request.updated_at_ms = now_ms
                changed = True
        if changed:
            self._save_requests()

    def policy_for(self, tool_name: str, approval_family: str | None) -> ApprovalPolicy | None:
        if not approval_family:
            return None
        value = self._tool_policies.get(tool_name)
        if value in ("allow", "ask", "deny"):
            return value
        return self._default_policy

    def has_grant(self, conversation_key: str, mode: str, approval_scope_key: str) -> bool:
        return any(
            grant.conversation_key == conversation_key
            and grant.mode == mode
            and grant.approval_scope_key == approval_scope_key
            for grant in self._load_grants()
        )

    def add_grant(self, request: ApprovalRequest) -> ApprovalGrant:
        now_ms = _now_ms()
        for grant in self._load_grants():
            if (
                grant.conversation_key == request.conversation_key
                and grant.mode == request.mode
                and grant.approval_scope_key == request.approval_scope_key
            ):
                grant.updated_at_ms = now_ms
                self._save_grants()
                return grant
        grant = ApprovalGrant(
            conversation_key=request.conversation_key,
            mode=request.mode,
            approval_scope_key=request.approval_scope_key,
            created_at_ms=now_ms,
            updated_at_ms=now_ms,
        )
        self._load_grants().append(grant)
        self._save_grants()
        return grant

    def create_request(
        self,
        *,
        tool_name: str,
        approval_family: str,
        approval_scope_key: str,
        params: dict[str, Any],
        preview: str,
        context: ApprovalContext,
    ) -> ApprovalRequest:
        self.expire_requests()
        now_ms = _now_ms()
        request = ApprovalRequest(
            id=uuid.uuid4().hex[:12],
            tool_name=tool_name,
            approval_family=approval_family,
            approval_scope_key=approval_scope_key,
            mode=context.mode,
            conversation_key=context.conversation_key,
            session_key=context.session_key,
            channel=context.channel,
            chat_id=context.chat_id,
            message_thread_id=context.message_thread_id,
            request_message_id=context.request_message_id,
            params=dict(params),
            preview=preview,
            status="pending",
            created_at_ms=now_ms,
            updated_at_ms=now_ms,
            expires_at_ms=now_ms + self._ttl_ms,
        )
        self._load_requests()[request.id] = request
        self._save_requests()
        return request

    def evaluate_tool_call(
        self,
        *,
        tool_name: str,
        approval_family: str | None,
        approval_scope_key: str | None,
        params: dict[str, Any],
        preview: str,
        context: ApprovalContext,
    ) -> ApprovalOutcome:
        policy = self.policy_for(tool_name, approval_family)
        if policy is None:
            return ApprovalOutcome(policy="allow")
        if policy == "allow":
            return ApprovalOutcome(policy="allow")
        if policy == "deny":
            return ApprovalOutcome(
                policy="deny",
                error=f"Execution denied by tool policy for '{tool_name}'.",
            )
        if approval_scope_key and self.has_grant(context.conversation_key, context.mode, approval_scope_key):
            return ApprovalOutcome(policy="allow")
        request = self.create_request(
            tool_name=tool_name,
            approval_family=approval_family or "tool",
            approval_scope_key=approval_scope_key or tool_name,
            params=params,
            preview=preview,
            context=context,
        )
        return ApprovalOutcome(policy="ask", request=request)

    def get_request(self, request_id: str) -> ApprovalRequest | None:
        self.expire_requests()
        return self._load_requests().get(request_id)

    def save_request(self, request: ApprovalRequest) -> None:
        request.updated_at_ms = _now_ms()
        self._load_requests()[request.id] = request
        self._save_requests()

    def list_pending_for_conversation(self, conversation_key: str) -> list[ApprovalRequest]:
        self.expire_requests()
        return [
            request
            for request in self._load_requests().values()
            if request.conversation_key == conversation_key and request.is_pending()
        ]

    def find_pending_by_message(
        self,
        conversation_key: str,
        request_message_id: int | None,
    ) -> ApprovalRequest | None:
        if request_message_id is None:
            return None
        for request in self.list_pending_for_conversation(conversation_key):
            if request.request_message_id == request_message_id:
                return request
        return None

    def resolve_request(
        self,
        request_id: str,
        *,
        status: ApprovalStatus,
        resolution_message: str | None = None,
    ) -> ApprovalRequest | None:
        request = self.get_request(request_id)
        if request is None:
            return None
        request.status = status
        request.resolution_message = resolution_message
        self.save_request(request)
        return request
