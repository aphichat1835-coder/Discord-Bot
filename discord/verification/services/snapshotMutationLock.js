"use strict";

const snapshotMutationLocks = new Map();

async function withSnapshotMutationLock(userId, operation) {
    const key = String(userId || "unknown");
    const previous = snapshotMutationLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    snapshotMutationLocks.set(key, current);
    try {
        return await current;
    } finally {
        if (snapshotMutationLocks.get(key) === current) snapshotMutationLocks.delete(key);
    }
}

module.exports = {
    snapshotMutationLocks,
    withSnapshotMutationLock
};
