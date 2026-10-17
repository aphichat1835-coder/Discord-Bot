#!/usr/bin/env node
import assert from "node:assert/strict";
import { ProgressReporter } from "../assets/patterns/progress-reporter.mjs";

const published = [];
const reporter = new ProgressReporter({
  minIntervalMs: 0,
  publish: async (state) => published.push({ ...state }),
});

reporter.phase("running", { completed: 0, total: 3, failed: 0, skipped: 0 });
reporter.update({ completed: 1 });
reporter.update({ completed: 3 });
await reporter.finalize({ phase: "succeeded" });
assert.equal(published.at(-1).phase, "succeeded");
assert.equal(published.at(-1).completed, 3);
assert.throws(() => reporter.update({ completed: 3 }), /closed/);

const guarded = new ProgressReporter({ minIntervalMs: 10_000, publish: async () => {} });
guarded.phase("running", { completed: 1, failed: 2, skipped: 1 });
assert.throws(() => guarded.update({ failed: 1 }), /backwards/);
guarded.phase("failed");
assert.throws(() => guarded.phase("running"), /terminal phase/);
guarded.close();

let attempts = 0;
const failure = new ProgressReporter({
  minIntervalMs: 0,
  publish: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transport failed");
  },
});
failure.phase("running");
await new Promise((resolve) => setTimeout(resolve, 5));
await assert.rejects(failure.flush(), /transport failed/);
assert.equal(attempts, 1);
await failure.flush();
assert.equal(attempts, 2);
failure.close();

console.log("javascript progress reporter self-test: PASS");
