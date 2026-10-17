from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class PurgeState:
    actor_id: int
    total: int
    phase: str = "validating"
    attempted: int = 0
    deleted: int = 0
    skipped: int = 0
    failed: int = 0
    terminal: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.total, int) or isinstance(self.total, bool) or self.total < 0:
            raise ValueError("total must be non-negative")


def start(state: PurgeState) -> PurgeState:
    _open(state)
    return replace(state, phase="working")


def account(state: PurgeState, *, attempted: int, deleted: int, skipped: int, failed: int) -> PurgeState:
    _open(state)
    counts = (attempted, deleted, skipped, failed)
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in counts) or deleted + skipped + failed != attempted:
        raise ValueError("batch accounting invariant violated")
    next_state = replace(state, phase="working", attempted=state.attempted + attempted, deleted=state.deleted + deleted, skipped=state.skipped + skipped, failed=state.failed + failed)
    if next_state.attempted > next_state.total:
        raise ValueError("attempted count exceeds total")
    return next_state


def finish(state: PurgeState) -> PurgeState:
    _open(state)
    if state.attempted != state.total:
        raise ValueError("cannot finish before all messages are accounted for")
    return replace(state, phase="partial" if state.failed or state.skipped else "succeeded", terminal=True)


def _open(state: PurgeState) -> None:
    if state.terminal:
        raise RuntimeError("terminal purge state cannot be updated")


def progress_copy(state: PurgeState) -> str:
    if state.phase == "validating":
        return "กำลังตรวจสอบสิทธิ์และค้นหาข้อความ…"
    if state.phase == "working":
        return f"กำลังลบ {state.attempted}/{state.total} • สำเร็จ {state.deleted} • ข้าม {state.skipped} • ล้มเหลว {state.failed}"
    if state.phase == "succeeded":
        return f"ลบข้อความสำเร็จ {state.deleted} รายการ"
    return f"ดำเนินการครบแล้ว • สำเร็จ {state.deleted} • ข้าม {state.skipped} • ล้มเหลว {state.failed}"
