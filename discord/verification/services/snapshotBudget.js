"use strict";

const MIN_MAX_BYTES = 128 * 1024;
const MAX_MAX_BYTES = 12 * 1024 * 1024;

function resolveDefaultMaxBytes(raw = process.env.VERIFICATION_SNAPSHOT_MAX_BYTES) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return MAX_MAX_BYTES;
    if (parsed < MIN_MAX_BYTES) {
        process.emitWarning(
            `VERIFICATION_SNAPSHOT_MAX_BYTES=${parsed} is below the safe minimum; using ${MIN_MAX_BYTES}`,
            { code: "VERIFICATION_SNAPSHOT_MAX_BYTES_FLOORED" }
        );
        return MIN_MAX_BYTES;
    }
    if (parsed > MAX_MAX_BYTES) {
        process.emitWarning(
            `VERIFICATION_SNAPSHOT_MAX_BYTES=${parsed} exceeds the safe maximum; using ${MAX_MAX_BYTES}`,
            { code: "VERIFICATION_SNAPSHOT_MAX_BYTES_CAPPED" }
        );
        return MAX_MAX_BYTES;
    }
    return parsed;
}

const DEFAULT_MAX_BYTES = resolveDefaultMaxBytes();

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
    MIN_MAX_BYTES,
    MAX_MAX_BYTES,
    resolveDefaultMaxBytes,
    jsonBytes,
    assertSnapshotBudget,
    failureMeta
};
