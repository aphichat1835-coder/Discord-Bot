"use strict";

const DEFAULT_MAX_BYTES = Math.max(
    128 * 1024,
    Number(process.env.VERIFICATION_SNAPSHOT_MAX_BYTES || 12 * 1024 * 1024) || 12 * 1024 * 1024
);

function jsonBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function assertSnapshotBudget(value, { maxBytes = DEFAULT_MAX_BYTES, label = "snapshot" } = {}) {
    const bytes = jsonBytes(value);
    if (bytes > maxBytes) {
        const err = new Error(`${label} payload too large`);
        err.code = "payload_too_large";
        err.bytes = bytes;
        err.maxBytes = maxBytes;
        throw err;
    }
    return {
        ok: true,
        bytes,
        maxBytes,
        truncated: false
    };
}

function failureMeta(err, source = "snapshot_budget") {
    return {
        status: "failed",
        source,
        truncated: true,
        failureReason: err?.code || "payload_too_large",
        bytes: err?.bytes || null,
        maxBytes: err?.maxBytes || DEFAULT_MAX_BYTES,
        updatedAt: Date.now()
    };
}

module.exports = {
    DEFAULT_MAX_BYTES,
    jsonBytes,
    assertSnapshotBudget,
    failureMeta
};
