const assert = require("node:assert/strict");
const test = require("node:test");
const { OperationQueue } = require("../voiceWorker/queue");

test("OperationQueue runs tasks up to concurrency limit", async () => {
    const q = new OperationQueue(2, 10, "test");
    let running = 0;
    let maxRunning = 0;

    const task = () =>
        new Promise(resolve => {
            running++;
            if (running > maxRunning) maxRunning = running;
            setImmediate(() => {
                running--;
                resolve();
            });
        });

    await Promise.all([q.add(task), q.add(task), q.add(task)]);
    assert.ok(maxRunning <= 2, `max concurrent should be <= 2, got ${maxRunning}`);
});

test("OperationQueue resolves task return values", async () => {
    const q = new OperationQueue(2, 10, "test");
    const result = await q.add(async () => 42);
    assert.equal(result, 42);
});

test("OperationQueue rejects when task throws", async () => {
    const q = new OperationQueue(2, 10, "test");
    await assert.rejects(
        () => q.add(async () => { throw new Error("task error"); }),
        /task error/
    );
});

test("OperationQueue rejects with OPERATION_QUEUE_FULL when full", async () => {
    const q = new OperationQueue(1, 2, "test");
    // Fill the queue: 1 running + 2 queued = max
    let unblock;
    const blocker = () => new Promise(r => { unblock = r; });
    q.add(blocker); // starts running, blocks
    q.add(async () => {}); // queued slot 1
    q.add(async () => {}); // queued slot 2

    // Next one should be rejected
    const err = await assert.rejects(
        () => q.add(async () => {}),
        err => {
            assert.equal(err.code, "OPERATION_QUEUE_FULL");
            assert.equal(err.queueName, "test");
            return true;
        }
    );
    unblock();
});

test("OperationQueue increments rejectedFull counter on overflow", async () => {
    const q = new OperationQueue(1, 1, "test");
    let unblock;
    q.add(() => new Promise(r => { unblock = r; })); // running
    q.add(async () => {});                            // fills the 1-slot queue

    try { await q.add(async () => {}); } catch (_) {}
    try { await q.add(async () => {}); } catch (_) {}

    assert.equal(q.rejectedFull, 2);
    unblock();
});

test("OperationQueue size and pending reflect queue state", async () => {
    const q = new OperationQueue(1, 10, "test");
    let unblock;
    q.add(() => new Promise(r => { unblock = r; })); // 1 running
    q.add(async () => {});                            // 1 queued

    assert.equal(q.running, 1);
    assert.equal(q.size, 1);
    assert.equal(q.pending, 2);
    unblock();
});

test("OperationQueue drains fully after all tasks complete", async () => {
    const q = new OperationQueue(2, 10, "test");
    await Promise.all([
        q.add(async () => 1),
        q.add(async () => 2),
        q.add(async () => 3)
    ]);
    assert.equal(q.size, 0);
    assert.equal(q.running, 0);
    assert.equal(q.pending, 0);
});
