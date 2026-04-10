"""Deterministic execution of approved scheduler proposal bundles."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from nanobot.agent.scheduler_contract import ProposalBundle, ProposalOperation
from nanobot.agent.tools.registry import ToolRegistry

_MAX_EXECUTOR_CONCURRENCY = 3


@dataclass(frozen=True, slots=True)
class OperationResult:
    """Structured outcome for one proposal-bundle operation."""

    operation_id: str
    tool_name: str
    status: str
    summary: str = ""
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "tool_name": self.tool_name,
            "status": self.status,
            "summary": self.summary,
            "detail": self.detail,
        }


@dataclass(frozen=True, slots=True)
class BundleExecutionResult:
    """Structured best-effort execution result for a proposal bundle."""

    bundle_id: str
    completed: tuple[OperationResult, ...] = field(default_factory=tuple)
    failed: tuple[OperationResult, ...] = field(default_factory=tuple)
    skipped: tuple[OperationResult, ...] = field(default_factory=tuple)
    partial_application: bool = False
    summary: str = ""
    recovery_steps: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "bundle_id": self.bundle_id,
            "completed": [item.to_dict() for item in self.completed],
            "failed": [item.to_dict() for item in self.failed],
            "skipped": [item.to_dict() for item in self.skipped],
            "partial_application": self.partial_application,
            "summary": self.summary,
            "recovery_steps": list(self.recovery_steps),
        }


class SchedulerBundleExecutor:
    """Apply an approved scheduler bundle using deterministic best-effort execution."""

    def __init__(self, tools: ToolRegistry, *, concurrency_limit: int = _MAX_EXECUTOR_CONCURRENCY):
        self._tools = tools
        self._concurrency_limit = max(1, min(_MAX_EXECUTOR_CONCURRENCY, int(concurrency_limit)))

    async def execute_bundle(self, bundle: ProposalBundle) -> BundleExecutionResult:
        completed: list[OperationResult] = []
        failed: list[OperationResult] = []
        skipped: list[OperationResult] = []
        results_by_id: dict[str, OperationResult] = {}
        pending: list[ProposalOperation] = list(bundle.operations)
        order = {item.id: index for index, item in enumerate(bundle.operations)}

        while pending:
            ready: list[ProposalOperation] = []
            remaining: list[ProposalOperation] = []
            for operation in pending:
                if any(dep not in results_by_id for dep in operation.depends_on):
                    remaining.append(operation)
                    continue
                dependency_failures = [
                    results_by_id[dep]
                    for dep in operation.depends_on
                    if results_by_id[dep].status != "completed"
                ]
                if dependency_failures:
                    result = OperationResult(
                        operation_id=operation.id,
                        tool_name=operation.tool_name,
                        status="skipped",
                        summary=operation.summary,
                        detail="Dependency did not complete successfully.",
                    )
                    skipped.append(result)
                    results_by_id[operation.id] = result
                    continue
                ready.append(operation)
            if not ready:
                for operation in remaining:
                    result = OperationResult(
                        operation_id=operation.id,
                        tool_name=operation.tool_name,
                        status="skipped",
                        summary=operation.summary,
                        detail="Dependency cycle or unresolved dependency.",
                    )
                    skipped.append(result)
                    results_by_id[operation.id] = result
                break

            ready.sort(key=lambda item: order[item.id])
            pending = remaining
            for index in range(0, len(ready), self._concurrency_limit):
                batch = ready[index : index + self._concurrency_limit]
                batch_results = await asyncio.gather(
                    *(self._execute_operation(item) for item in batch)
                )
                for result in batch_results:
                    results_by_id[result.operation_id] = result
                    if result.status == "completed":
                        completed.append(result)
                    elif result.status == "failed":
                        failed.append(result)
                    else:
                        skipped.append(result)

        partial_application = bool(completed) and bool(failed or skipped)
        summary = (
            f"Applied bundle {bundle.bundle_id}: "
            f"{len(completed)} completed, {len(failed)} failed, {len(skipped)} skipped."
        )
        recovery_steps: list[str] = []
        if failed or skipped:
            recovery_steps.append("Review failed or skipped operations before retrying.")
            if partial_application:
                recovery_steps.append("Schedule state may be partially applied; reconcile before retry.")
        return BundleExecutionResult(
            bundle_id=bundle.bundle_id,
            completed=tuple(completed),
            failed=tuple(failed),
            skipped=tuple(skipped),
            partial_application=partial_application,
            summary=summary,
            recovery_steps=tuple(recovery_steps),
        )

    async def _execute_operation(self, operation: ProposalOperation) -> OperationResult:
        tool, params, error = self._tools.prepare_call(operation.tool_name, dict(operation.params))
        if error or tool is None:
            return OperationResult(
                operation_id=operation.id,
                tool_name=operation.tool_name,
                status="failed",
                summary=operation.summary,
                detail=(error or "Tool unavailable."),
            )
        try:
            result = await tool.execute(**params)
        except Exception as exc:
            return OperationResult(
                operation_id=operation.id,
                tool_name=operation.tool_name,
                status="failed",
                summary=operation.summary,
                detail=f"{type(exc).__name__}: {exc}",
            )
        detail = "" if result is None else str(result).strip()
        if detail.startswith("Error"):
            return OperationResult(
                operation_id=operation.id,
                tool_name=operation.tool_name,
                status="failed",
                summary=operation.summary,
                detail=detail,
            )
        return OperationResult(
            operation_id=operation.id,
            tool_name=operation.tool_name,
            status="completed",
            summary=operation.summary,
            detail=detail,
        )
