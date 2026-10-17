const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);

export function createPurgeState({ actorId, total }) {
  if (!actorId || !Number.isInteger(total) || total < 0) throw new TypeError("actorId and non-negative integer total are required");
  return Object.freeze({ phase: "validating", actorId, total, attempted: 0, deleted: 0, skipped: 0, failed: 0, terminal: false });
}

export function transition(state, event) {
  if (state.terminal) throw new Error("terminal purge state cannot be updated");
  if (event.type === "start") return Object.freeze({ ...state, phase: "working" });
  if (event.type === "batch") {
    const next = {
      ...state,
      phase: "working",
      attempted: state.attempted + event.attempted,
      deleted: state.deleted + event.deleted,
      skipped: state.skipped + event.skipped,
      failed: state.failed + event.failed,
    };
    if ([next.attempted, next.deleted, next.skipped, next.failed].some(value => !Number.isInteger(value) || value < 0)) throw new TypeError("batch counts must be non-negative integers");
    if (next.deleted + next.skipped + next.failed !== next.attempted) throw new Error("batch accounting invariant violated");
    if (next.attempted > next.total) throw new Error("attempted count exceeds total");
    return Object.freeze(next);
  }
  if (event.type === "finish") {
    if (state.attempted !== state.total) throw new Error("cannot finish before all selected messages are accounted for");
    const phase = state.failed || state.skipped ? "partial" : "succeeded";
    return Object.freeze({ ...state, phase, terminal: true });
  }
  if (event.type === "fail" || event.type === "cancel") {
    const phase = event.type === "fail" ? "failed" : "cancelled";
    return Object.freeze({ ...state, phase, terminal: TERMINAL.has(phase), reason: event.reason ?? null });
  }
  throw new Error(`unknown purge event: ${event.type}`);
}

export function progressCopy(state) {
  if (state.phase === "validating") return "กำลังตรวจสอบสิทธิ์และค้นหาข้อความ…";
  if (state.phase === "working") return `กำลังลบ ${state.attempted}/${state.total} • สำเร็จ ${state.deleted} • ข้าม ${state.skipped} • ล้มเหลว ${state.failed}`;
  if (state.phase === "succeeded") return `ลบข้อความสำเร็จ ${state.deleted} รายการ`;
  if (state.phase === "partial") return `ดำเนินการครบแล้ว • สำเร็จ ${state.deleted} • ข้าม ${state.skipped} • ล้มเหลว ${state.failed}`;
  if (state.phase === "cancelled") return "ยกเลิกการลบข้อความแล้ว";
  return `หยุดการทำงาน${state.reason ? `: ${state.reason}` : ""}`;
}
