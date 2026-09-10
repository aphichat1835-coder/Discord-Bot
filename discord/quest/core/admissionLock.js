'use strict';

const ownerQueues = new Map();
const accountQueues = new Map();

async function withKeyedLock(queues, key, operation, label) {
    if (!key) throw new TypeError(`${label} is required`);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');

    const previous = queues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const queued = previous.then(() => gate);
    queues.set(key, queued);

    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (queues.get(key) === queued) queues.delete(key);
    }
}

function withOwnerAdmissionLock(ownerId, operation) {
    return withKeyedLock(ownerQueues, ownerId, operation, 'ownerId');
}

function withAccountAdmissionLock(accountId, operation) {
    return withKeyedLock(accountQueues, accountId, operation, 'accountId');
}

module.exports = {
    withOwnerAdmissionLock,
    withAccountAdmissionLock
};
