import test from "node:test";
import assert from "node:assert/strict";
import { createPurgeState, transition } from "./core.mjs";

test("accounts for partial success and closes terminal state", () => {
  let state = transition(createPurgeState({ actorId: "1", total: 2 }), { type: "start" });
  state = transition(state, { type: "batch", attempted: 1, deleted: 1, skipped: 0, failed: 0 });
  state = transition(state, { type: "batch", attempted: 1, deleted: 0, skipped: 0, failed: 1 });
  state = transition(state, { type: "finish" });
  assert.equal(state.phase, "partial");
  assert.throws(() => transition(state, { type: "start" }), /terminal/);
});

test("rejects false progress accounting", () => {
  const state = transition(createPurgeState({ actorId: "1", total: 1 }), { type: "start" });
  assert.throws(() => transition(state, { type: "batch", attempted: 1, deleted: 1, skipped: 1, failed: 0 }), /accounting/);
});
