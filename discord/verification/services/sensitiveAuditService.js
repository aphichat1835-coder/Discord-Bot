"use strict";

const { buildSensitiveAccessAuditUpdate } = require("../utils/sensitiveAccess");

const WINDOW_MS = Math.max(30_000, Number(process.env.SENSITIVE_REVEAL_WINDOW_MS || 5 * 60_000) || 5 * 60_000);
const MAX_EVENTS = Math.max(1, Number(process.env.SENSITIVE_REVEAL_MAX || 10) || 10);
const rawUserCooldown = process.env.SENSITIVE_REVEAL_USER_COOLDOWN_MS;
const configuredUserCooldown = rawUserCooldown === undefined || rawUserCooldown === ""
    ? Number.NaN
    : Number(rawUserCooldown);
const USER_COOLDOWN_MS = Math.max(
    0,
    Number.isFinite(configuredUserCooldown) ? configuredUserCooldown : 45_000
);
const MAX_BUCKET_KEYS = Math.max(100, Number(process.env.SENSITIVE_REVEAL_BUCKET_MAX || 10_000) || 10_000);
const buckets = new Map();

function nowMs() {
    return Date.now();
}

function safeReason(reason) {
    const value = String(reason || "").trim();
    if (!value) {
        const err = new Error("reason is required");
        err.code = "reason_required";
        throw err;
    }
    if (value.length > 500) {
        const err = new Error("reason must be 500 characters or fewer");
        err.code = "reason_too_long";
        throw err;
    }
    return value;
}

function keyFor({ actor = "owner-dashboard", guildId = "", userId = "", action = "sensitive" } = {}) {
    return [action, actor, guildId, userId].map(v => String(v || "")).join(":");
}

function sweepBuckets(now = nowMs()) {
    for (const [key, timestamps] of buckets) {
        const active = timestamps.filter(ts => now - ts < WINDOW_MS);
        if (active.length) buckets.set(key, active);
        else buckets.delete(key);
    }
    while (buckets.size > MAX_BUCKET_KEYS) {
        buckets.delete(buckets.keys().next().value);
    }
    return buckets.size;
}

const sweepTimer = setInterval(() => sweepBuckets(), Math.min(WINDOW_MS, 60_000));
sweepTimer.unref?.();

function checkRevealLimit(input = {}, now = nowMs()) {
    if (buckets.size >= MAX_BUCKET_KEYS) sweepBuckets(now);
    const key = keyFor(input);
    const globalKey = keyFor({ ...input, userId: "*" });
    for (const currentKey of [key, globalKey]) {
        const list = (buckets.get(currentKey) || []).filter(ts => now - ts < WINDOW_MS);
        buckets.set(currentKey, list);
        if (list.length >= MAX_EVENTS) {
            const err = new Error("sensitive reveal rate limit exceeded");
            err.code = "rate_limited";
            err.retryAfterMs = WINDOW_MS - (now - list[0]);
            throw err;
        }
        if (currentKey === key && list.length && now - list[list.length - 1] < USER_COOLDOWN_MS) {
            const err = new Error("sensitive reveal cooldown active for this user");
            err.code = "cooldown";
            err.retryAfterMs = USER_COOLDOWN_MS - (now - list[list.length - 1]);
            throw err;
        }
    }
    buckets.set(key, [...(buckets.get(key) || []), now]);
    buckets.set(globalKey, [...(buckets.get(globalKey) || []), now]);
}

function auditGuildConfigUpdate({ actor, route, scope = ["rawIp"], now = nowMs() } = {}) {
    return buildSensitiveAccessAuditUpdate({
        actor: actor || "owner-dashboard",
        route: route || "sensitive-reveal",
        scope,
        now
    });
}

function auditVerifyLogEntry({ action, actor, reason, viewedAt = nowMs() } = {}) {
    return {
        action: action || "owner_sensitive_reveal",
        actor: actor || "owner-dashboard",
        reason: safeReason(reason),
        viewedAt
    };
}

module.exports = {
    safeReason,
    checkRevealLimit,
    auditGuildConfigUpdate,
    auditVerifyLogEntry,
    _test: {
        buckets,
        keyFor,
        sweepBuckets,
        MAX_BUCKET_KEYS,
        sweepTimer
    }
};
