"use strict";

const MODERATION_PRIORITY = Object.freeze({
    allow: 0,
    deny_role: 1,
    timeout: 2,
    kick: 3,
    ban: 4
});

function makeRuleViolation(key, rule, reason, userError) {
    return {
        key,
        action: rule.action || "deny_role",
        timeoutMinutes: Number(rule.timeoutMinutes) || 60,
        reason,
        userError
    };
}

function strongestRuleViolation(violations = []) {
    if (!violations.length) return null;
    return violations.reduce((strongest, current) => {
        if (!strongest) return current;
        const currentRank = MODERATION_PRIORITY[current.action] ?? 1;
        const strongestRank = MODERATION_PRIORITY[strongest.action] ?? 1;
        return currentRank > strongestRank ? current : strongest;
    }, null);
}

function uniqueStrings(values = []) {
    return Array.from(new Set((values || []).map(v => String(v || "").trim()).filter(Boolean)));
}

function evaluateProfilePolicy({ profile, policySnapshot, connections, findings, violations }) {
    const minAge = Number(policySnapshot.minAccountAgeDays) || 0;
    if (minAge > 0 && profile.accountAgeDays < minAge) {
        findings.push("new_account");
        violations.push({
            key: "accountAge",
            action: "deny_role",
            reason: `new_account:${profile.accountAgeDays}`,
            userError: `บัญชีของคุณยังใหม่อยู่ (เปิดมาแล้ว ${profile.accountAgeDays} วัน เซิร์ฟเวอร์ต้องการอย่างน้อย ${minAge} วัน)`
        });
    }

    if (policySnapshot.requireEmail && !profile.email) {
        findings.push("email_missing_or_unverified");
        violations.push({
            key: "email",
            action: "deny_role",
            reason: "email_missing",
            userError: "บัญชี Discord ของคุณต้องผูกอีเมลเพื่อยืนยันตัวตนในเซิร์ฟเวอร์นี้"
        });
    } else if (policySnapshot.requireEmailVerified && !profile.emailVerified) {
        findings.push("email_missing_or_unverified");
        violations.push({
            key: "emailVerified",
            action: "deny_role",
            reason: "email_unverified",
            userError: "อีเมลของบัญชี Discord ยังไม่ได้รับการยืนยัน กรุณายืนยันอีเมลก่อน"
        });
    }

    if (policySnapshot.requireConnections && !connections?.length) {
        findings.push("no_connections");
        violations.push({
            key: "requireConnections",
            action: "deny_role",
            reason: "no_connections",
            userError: "เซิร์ฟเวอร์นี้ต้องการให้บัญชี Discord ของคุณเชื่อมต่อกับบริการภายนอก (เช่น Steam, YouTube, GitHub) ก่อนยืนยันตัวตน"
        });
    }
}

function _recordAnonymizerAndHostingFindings(ipInfo, securityRules, findings, violations) {
    const isAnonymizer = Boolean(ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTOR);
    const isHosting = Boolean(ipInfo.hosting);

    if (isAnonymizer || isHosting) {
        findings.push("network_anonymizer_or_hosting");
    }
    if (ipInfo.isVPN) findings.push("vpn");
    if (ipInfo.isProxy) findings.push("proxy");
    if (ipInfo.isTOR) findings.push("tor");
    if (ipInfo.hosting) findings.push("hosting");

    const vpnRule = securityRules.vpnProxyTor;
    if (isAnonymizer && vpnRule?.enabled === true) {
        violations.push(makeRuleViolation(
            "vpnProxyTor",
            vpnRule,
            "network_vpn_proxy_tor",
            "เซิร์ฟเวอร์ไม่อนุญาตให้ใช้ VPN หรือ Proxy ในการยืนยันตัวตน กรุณาปิดแล้วลองใหม่อีกครั้ง"
        ));
    }

    const hostingRule = securityRules.hosting;
    if (isHosting && hostingRule?.enabled === true) {
        violations.push(makeRuleViolation(
            "hosting",
            hostingRule,
            "network_hosting",
            "เครือข่ายนี้ถูกระบุว่าเป็น Hosting หรือ Datacenter กรุณาใช้เครือข่ายอินเทอร์เน็ตทั่วไป"
        ));
    }
}

function _evaluateSpoofAndLookup(ipInfo, securityRules, findings, violations) {
    if (ipInfo.spoofSuspected) {
        findings.push("spoofed_ip_header");
        const spoofRule = securityRules.spoofedHeader;
        if (spoofRule?.enabled === true) {
            violations.push(makeRuleViolation(
                "spoofedHeader",
                spoofRule,
                "spoofed_ip_header",
                "ข้อมูลเครือข่ายจากเบราว์เซอร์ไม่ตรงกัน กรุณาเปลี่ยนเครือข่ายแล้วลองใหม่อีกครั้ง"
            ));
        }
    }

    if (ipInfo.lookupStatus === "lookup_failed" || ipInfo.lookupStatus === "ip_unknown") {
        const unknownFinding = ipInfo.lookupStatus === "ip_unknown" ? "ip_unknown" : "ip_lookup_failed";
        findings.push(unknownFinding);
        const unknownRule = securityRules.unknownLookup;
        if (unknownRule?.enabled === true) {
            violations.push(makeRuleViolation(
                "unknownLookup",
                unknownRule,
                unknownFinding,
                "ระบบตรวจสอบเครือข่ายขัดข้องชั่วคราว กรุณารอสักครู่แล้วลองใหม่อีกครั้ง"
            ));
        }
    }
}

function evaluateNetworkIntelligence({ ipInfo, securityRules, findings, violations }) {
    _recordAnonymizerAndHostingFindings(ipInfo, securityRules, findings, violations);
    _evaluateSpoofAndLookup(ipInfo, securityRules, findings, violations);
}

function evaluateIpDuplicates({ existingIpLink, trackedUsers, profile, securityRules, findings, violations }) {
    if (!existingIpLink) return;

    const otherUsers = trackedUsers.filter(u => String(u.userId || "") !== String(profile.id));
    const projectedUniqueUsers = otherUsers.length + 1;
    const ipDupRule = securityRules.ipDuplicate;
    const ipThreshold = Number(ipDupRule?.threshold || 3);

    if (projectedUniqueUsers > ipThreshold) {
        findings.push(`ip_duplicate_limit:${projectedUniqueUsers}`);
        if (ipDupRule?.enabled === true && ipDupRule?.action !== "allow") {
            violations.push(makeRuleViolation(
                "ipDuplicate",
                ipDupRule,
                `ip_duplicate_limit:${projectedUniqueUsers}`,
                "เครือข่ายนี้มีจำนวนบัญชีที่ยืนยันเกินขีดจำกัดที่กำหนดไว้"
            ));
        }
    }

    const previouslyBlocked = existingIpLink.lastResult === "blocked" || trackedUsers.some(u =>
        Number(u.blockedCount || 0) > 0 ||
        (Array.isArray(u.lastFindings) && u.lastFindings.some(f => /blocked|vpn|proxy|tor|spoof|duplicate|hosting/i.test(f)))
    );
    if (previouslyBlocked) {
        findings.push("previously_blocked_ip");
        const prevBlockRule = securityRules.previouslyBlockedIp;
        if (prevBlockRule?.enabled === true) {
            violations.push(makeRuleViolation(
                "previouslyBlockedIp",
                prevBlockRule,
                "previously_blocked_ip",
                "เครือข่ายนี้เคยถูกระงับสิทธิ์ในการยืนยันตัวตนมาก่อน"
            ));
        }
    }
}

function evaluateDeviceDuplicates({ device, deviceSummary, profile, securityRules, findings, violations }) {
    if (!device?.fingerprintHash) return;

    const deviceUsers = Array.isArray(deviceSummary?.userIds) ? deviceSummary.userIds : [];
    const otherDeviceUsers = deviceUsers.filter(uid => String(uid || "") !== String(profile?.id || ""));
    const projectedDeviceUsers = otherDeviceUsers.length + 1;
    const devRule = securityRules.deviceDuplicate;
    const devThreshold = Number(devRule?.threshold || 2);

    if (projectedDeviceUsers > devThreshold) {
        findings.push(`device_duplicate_limit:${projectedDeviceUsers}`);
        if (devRule?.enabled === true && devRule?.action !== "allow") {
            violations.push(makeRuleViolation(
                "deviceDuplicate",
                devRule,
                `device_duplicate_limit:${projectedDeviceUsers}`,
                "อุปกรณ์นี้มีจำนวนบัญชีที่ยืนยันเกินขีดจำกัดที่กำหนดไว้"
            ));
        }
    }
}

/**
 * Evaluates security detections and enforcement rules.
 * Detection always runs and records all findings.
 * Enforcement is only applied if the corresponding rule has enabled: true.
 */
function evaluateSecurity({
    profile,
    ipInfo = {},
    device = null,
    connections = [],
    existingIpLink = null,
    securityRules = {},
    policySnapshot = {},
    trackedUsers = [],
    deviceSummary = null
}) {
    const findings = [];
    const violations = [];

    evaluateProfilePolicy({ profile, policySnapshot, connections, findings, violations });
    evaluateNetworkIntelligence({ ipInfo, securityRules, findings, violations });
    evaluateIpDuplicates({ existingIpLink, trackedUsers, profile, securityRules, findings, violations });
    evaluateDeviceDuplicates({ device, deviceSummary, profile, securityRules, findings, violations });

    const primaryViolation = strongestRuleViolation(violations);

    return {
        findings: uniqueStrings(findings),
        allViolations: violations,
        primaryViolation,
        isBlocked: Boolean(primaryViolation && primaryViolation.action !== "allow"),
        blockedReason: primaryViolation?.reason || null,
        userError: primaryViolation?.userError || null,
        moderationAction: primaryViolation?.action || null,
        timeoutMinutes: primaryViolation?.timeoutMinutes || 60
    };
}

module.exports = {
    MODERATION_PRIORITY,
    makeRuleViolation,
    strongestRuleViolation,
    uniqueStrings,
    evaluateSecurity
};
