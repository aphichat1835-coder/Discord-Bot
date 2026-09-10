"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { drainDmService } = require("../dm/drain");

test("DM drain waits for the active worker and persists volatile records before returning", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let busy = true;
    let stopped = false;
    let persisted = false;
    const service = {
        stop() { stopped = true; return true; },
        getDiagnostics() { return { workerBusy: busy }; },
        async persistVolatileOutbox() {
            persisted = true;
            return { persisted: 2 };
        }
    };
    setImmediate(() => { busy = false; });

    const result = await drainDmService(service, { timeoutMs: 1000, pollMs: 5 });

    assert.equal(stopped, true);
    assert.equal(persisted, true);
    assert.deepEqual(result, { stopped: true, drained: true, persisted: 2 });
});

test("DM drain fails closed when a worker does not finish before timeout", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let clock = 0;
    const service = {
        stop() { return true; },
        getDiagnostics() { return { workerBusy: true }; }
    };

    await assert.rejects(
        drainDmService(service, {
            timeoutMs: 100,
            pollMs: 10,
            now: () => clock,
            setTimer(callback) {
                clock += 50;
                return setImmediate(callback);
            }
        }),
        error => error?.code === "DM_DRAIN_TIMEOUT"
    );
});