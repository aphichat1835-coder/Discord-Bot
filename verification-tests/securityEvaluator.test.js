"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    MODERATION_PRIORITY,
    makeRuleViolation,
    strongestRuleViolation,
    uniqueStrings,
    evaluateSecurity
} = require("../discord/verification/services/securityEvaluator");

test("securityEvaluator helper functions", () => {
    assert.equal(MODERATION_PRIORITY.allow, 0);
    assert.equal(MODERATION_PRIORITY.ban, 4);

    const violation = makeRuleViolation("vpn", { action: "kick", timeoutMinutes: 30 }, "vpn_detected", "No VPN allowed");
    assert.equal(violation.key, "vpn");
    assert.equal(violation.action, "kick");
    assert.equal(violation.timeoutMinutes, 30);
    assert.equal(violation.reason, "vpn_detected");
    assert.equal(violation.userError, "No VPN allowed");

    assert.equal(strongestRuleViolation([]), null);
    const strongest = strongestRuleViolation([
        { action: "deny_role" },
        { action: "ban" },
        { action: "timeout" }
    ]);
    assert.equal(strongest.action, "ban");

    assert.deepEqual(uniqueStrings([" a ", "b", "a", "", null, undefined, "b "]), ["a", "b"]);
});

test("evaluateSecurity passes clean profiles with no findings or violations", () => {
    const result = evaluateSecurity({
        profile: {
            id: "user123",
            accountAgeDays: 30,
            email: "user@example.com",
            emailVerified: true
        },
        policySnapshot: {
            minAccountAgeDays: 7,
            requireEmail: true,
            requireEmailVerified: true
        },
        connections: [{ type: "steam" }],
        ipInfo: {
            isVPN: false,
            isProxy: false,
            isTOR: false,
            hosting: false,
            lookupStatus: "success"
        }
    });

    assert.equal(result.isBlocked, false);
    assert.equal(result.primaryViolation, null);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.allViolations, []);
});

test("evaluateSecurity flags and blocks new accounts, missing email, and missing connections", () => {
    const result = evaluateSecurity({
        profile: {
            id: "user_new",
            accountAgeDays: 2,
            email: null,
            emailVerified: false
        },
        policySnapshot: {
            minAccountAgeDays: 7,
            requireEmail: true,
            requireConnections: true
        },
        connections: []
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.includes("new_account"));
    assert.ok(result.findings.includes("email_missing_or_unverified"));
    assert.ok(result.findings.includes("no_connections"));
    assert.equal(result.moderationAction, "deny_role");
    assert.match(result.userError, /เปิดมาแล้ว 2 วัน/);
});

test("evaluateSecurity flags email unverified when required", () => {
    const result = evaluateSecurity({
        profile: {
            id: "user_unv",
            accountAgeDays: 10,
            email: "test@example.com",
            emailVerified: false
        },
        policySnapshot: {
            requireEmailVerified: true
        }
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.includes("email_missing_or_unverified"));
    assert.match(result.userError, /อีเมลของบัญชี Discord ยังไม่ได้รับการยืนยัน/);
});

test("evaluateSecurity detects VPN, proxy, TOR, and hosting with configured rule enforcement", () => {
    const result = evaluateSecurity({
        profile: { id: "user_vpn", accountAgeDays: 50 },
        ipInfo: {
            isVPN: true,
            isProxy: true,
            isTOR: true,
            hosting: true,
            spoofSuspected: true
        },
        securityRules: {
            vpnProxyTor: { enabled: true, action: "kick" },
            hosting: { enabled: true, action: "deny_role" },
            spoofedHeader: { enabled: true, action: "timeout", timeoutMinutes: 120 }
        }
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.includes("network_anonymizer_or_hosting"));
    assert.ok(result.findings.includes("vpn"));
    assert.ok(result.findings.includes("proxy"));
    assert.ok(result.findings.includes("tor"));
    assert.ok(result.findings.includes("hosting"));
    assert.ok(result.findings.includes("spoofed_ip_header"));
    // Kick is higher priority than timeout and deny_role
    assert.equal(result.moderationAction, "kick");
});

test("evaluateSecurity detects unknown or failed IP lookup", () => {
    const result = evaluateSecurity({
        profile: { id: "user_lookup", accountAgeDays: 50 },
        ipInfo: {
            lookupStatus: "lookup_failed"
        },
        securityRules: {
            unknownLookup: { enabled: true, action: "deny_role" }
        }
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.includes("ip_lookup_failed"));
    assert.match(result.userError, /ระบบตรวจสอบเครือข่ายขัดข้องชั่วคราว/);
});

test("evaluateSecurity detects IP duplicates and previously blocked IP", () => {
    const existingIpLink = { lastResult: "blocked" };
    const trackedUsers = [
        { userId: "other1", blockedCount: 1, lastFindings: ["vpn"] },
        { userId: "other2", blockedCount: 0 }
    ];

    const result = evaluateSecurity({
        profile: { id: "user_dup", accountAgeDays: 50 },
        existingIpLink,
        trackedUsers,
        securityRules: {
            ipDuplicate: { enabled: true, action: "deny_role", threshold: 1 },
            previouslyBlockedIp: { enabled: true, action: "deny_role" }
        }
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.some(f => f.startsWith("ip_duplicate_limit:")));
    assert.ok(result.findings.includes("previously_blocked_ip"));
});

test("evaluateSecurity detects device duplicates", () => {
    const result = evaluateSecurity({
        profile: { id: "user_dev", accountAgeDays: 50 },
        device: { fingerprintHash: "hash123" },
        deviceSummary: { userIds: ["u1", "u2", "u3"] },
        securityRules: {
            deviceDuplicate: { enabled: true, action: "deny_role", threshold: 2 }
        }
    });

    assert.equal(result.isBlocked, true);
    assert.ok(result.findings.some(f => f.startsWith("device_duplicate_limit:")));
    assert.match(result.userError, /อุปกรณ์นี้มีจำนวนบัญชีที่ยืนยันเกินขีดจำกัด/);
});
