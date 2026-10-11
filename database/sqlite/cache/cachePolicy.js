"use strict";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const DEFAULT_POLICIES = Object.freeze({
    profile: {
        ttlMs: 30 * ONE_DAY_MS,
        maxRows: 10000,
        priority: "normal"
    },
    avatar: {
        ttlMs: 30 * ONE_DAY_MS,
        maxRows: 10000,
        priority: "normal"
    },
    guild: {
        ttlMs: 7 * ONE_DAY_MS,
        maxRows: 500,
        priority: "high"
    },
    channel: {
        ttlMs: 7 * ONE_DAY_MS,
        maxRows: 2000,
        priority: "normal"
    },
    role: {
        ttlMs: 7 * ONE_DAY_MS,
        maxRows: 2000,
        priority: "high"
    },
    api: {
        ttlMs: 6 * ONE_HOUR_MS,
        maxRows: 5000,
        priority: "low"
    },
    voice: {
        ttlMs: 30 * ONE_DAY_MS,
        maxRows: 50000,
        priority: "normal"
    },
    default: {
        ttlMs: ONE_DAY_MS,
        maxRows: 1000,
        priority: "normal"
    }
});

const customPolicies = new Map();

function setPolicy(namespace, policy) {
    customPolicies.set(namespace, {
        ...(DEFAULT_POLICIES[namespace] || DEFAULT_POLICIES.default),
        ...policy
    });
}

function getPolicy(namespace) {
    if (customPolicies.has(namespace)) {
        return customPolicies.get(namespace);
    }
    return DEFAULT_POLICIES[namespace] || DEFAULT_POLICIES.default;
}

module.exports = {
    DEFAULT_POLICIES,
    getPolicy,
    setPolicy
};
