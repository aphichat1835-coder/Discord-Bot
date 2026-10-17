"""Framework-neutral coalescing progress reporter.

Wire ``publish`` to ``interaction.edit_original_response`` or another async
transport boundary. Adapt this file to the target repository.
"""

from __future__ import annotations

import asyncio
import inspect
import math
from collections.abc import Awaitable, Callable, Mapping
from types import MappingProxyType
from typing import Any

ProgressState = Mapping[str, Any]
Publisher = Callable[[ProgressState], Awaitable[None]]
Validator = Callable[[ProgressState, ProgressState], None]


class ProgressReporter:
    def __init__(
        self,
        *,
        publish: Publisher,
        min_interval: float = 1.0,
        validate: Validator | None = None,
    ) -> None:
        if not callable(publish):
            raise TypeError("publish must be callable")
        if not math.isfinite(min_interval) or min_interval < 0:
            raise ValueError("min_interval must be a non-negative finite number")

        self._publish = publish
        self._min_interval = min_interval
        self._validate = validate or validate_progress_state
        self._state: dict[str, Any] = {}
        self._version = 0
        self._published_version = 0
        self._last_published_at = float("-inf")
        self._timer_task: asyncio.Task[None] | None = None
        self._publish_lock = asyncio.Lock()
        self._last_error: BaseException | None = None
        self._closed = False

    @property
    def state(self) -> ProgressState:
        return MappingProxyType(dict(self._state))

    @property
    def pending(self) -> bool:
        return self._published_version < self._version

    def phase(self, name: str, **values: Any) -> "ProgressReporter":
        if not isinstance(name, str) or not name.strip():
            raise TypeError("phase name must be a non-empty string")
        return self.update(phase=name, **values)

    def update(self, **patch: Any) -> "ProgressReporter":
        if self._closed:
            raise RuntimeError("progress reporter is closed")

        previous = MappingProxyType(dict(self._state))
        next_state = {**self._state, **patch}
        self._validate(MappingProxyType(next_state), previous)
        self._state = next_state
        self._version += 1
        self._schedule()
        return self

    async def flush(self) -> None:
        await self._cancel_timer()
        if self._last_error is not None:
            error = self._last_error
            self._last_error = None
            raise error

        while self._published_version < self._version:
            await self._publish_latest()

    async def finalize(self, **patch: Any) -> None:
        if self._closed:
            raise RuntimeError("progress reporter is closed")
        self.update(**patch)
        await self.flush()
        await self.close()

    async def close(self) -> None:
        await self._cancel_timer()
        self._closed = True

    def _schedule(self) -> None:
        if self._timer_task is not None and not self._timer_task.done():
            return

        loop = asyncio.get_running_loop()
        elapsed = loop.time() - self._last_published_at
        delay = max(0.0, self._min_interval - elapsed)
        self._timer_task = loop.create_task(self._publish_after(delay))

    async def _publish_after(self, delay: float) -> None:
        try:
            if delay:
                await asyncio.sleep(delay)
            await self._publish_latest()
        except asyncio.CancelledError:
            raise
        except BaseException as error:
            self._last_error = error
        finally:
            if self._timer_task is asyncio.current_task():
                self._timer_task = None
            if (
                not self._closed
                and self._last_error is None
                and self._published_version < self._version
            ):
                self._schedule()

    async def _publish_latest(self) -> None:
        async with self._publish_lock:
            target_version = self._version
            snapshot = MappingProxyType(dict(self._state))
            result = self._publish(snapshot)
            if not inspect.isawaitable(result):
                raise TypeError("publish must return an awaitable")
            await result
            self._published_version = target_version
            self._last_published_at = asyncio.get_running_loop().time()
            self._last_error = None

    async def _cancel_timer(self) -> None:
        task = self._timer_task
        if task is None or task.done() or task is asyncio.current_task():
            self._timer_task = None
            return
        if self._publish_lock.locked():
            await task
            return
        self._timer_task = None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def validate_progress_state(next_state: ProgressState, previous: ProgressState) -> None:
    for key in ("completed", "total", "failed", "skipped"):
        value = next_state.get(key)
        if value is not None and (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
        ):
            raise ValueError(f"{key} must be a non-negative finite number")

    completed = next_state.get("completed")
    total = next_state.get("total")
    if completed is not None and total is not None and completed > total:
        raise ValueError("completed cannot exceed total")

    for key in ("completed", "failed", "skipped"):
        previous_value = previous.get(key)
        next_value = next_state.get(key)
        if previous_value is not None and next_value is not None and next_value < previous_value:
            raise ValueError(f"{key} progress cannot move backwards")

    terminal_phases = {
        "empty", "permission_denied", "partial", "success", "succeeded", "failed",
        "cancelled", "timed_out",
    }
    previous_phase = previous.get("phase")
    next_phase = next_state.get("phase")
    if previous_phase in terminal_phases and next_phase != previous_phase:
        raise ValueError(f"terminal phase {previous_phase} cannot transition to {next_phase}")
