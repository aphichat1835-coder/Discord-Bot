"use strict";

function evaluateCriticalPersistence({ oauthSaved, verifyLogSaved, trackingRequired, trackingSaved, verifyLogDegraded = false }) {
    const persistence = {
        oauthUser: oauthSaved === true,
        verifyLog: verifyLogSaved === true && verifyLogDegraded !== true,
        ipTracking: trackingRequired !== true || trackingSaved === true
    };
    return {
        persistence,
        ok: Object.values(persistence).every(Boolean),
        degraded: verifyLogDegraded === true
    };
}

function sendWebhookEventSafe(...args) {
    try {
        const webhooks = require("../../core/webhooks");
        if (typeof webhooks.sendWebhookEvent === "function") {
            return webhooks.sendWebhookEvent(...args);
        }
    } catch {
        // optional in isolated unit tests
    }
    return Promise.resolve(false);
}

function roleWasApplied(resultOrRoleAssign, maybeRoleAssign) {
    const roleAssign = (maybeRoleAssign && typeof maybeRoleAssign === "object")
        ? maybeRoleAssign
        : (resultOrRoleAssign && typeof resultOrRoleAssign === "object" ? resultOrRoleAssign : null);

    return Boolean(
        roleAssign?.ok === true &&
        roleAssign?.alreadyHadRole !== true
    );
}

async function executeRoleRollback(roleApplied, removeRole) {
    if (!roleApplied || typeof removeRole !== "function") {
        return { rollbackAttempted: false, rollbackSucceeded: false };
    }
    try {
        const rollback = await removeRole();
        return { rollbackAttempted: true, rollbackSucceeded: rollback?.ok === true };
    } catch {
        return { rollbackAttempted: true, rollbackSucceeded: false };
    }
}

function notifyRollbackOutcome(roleApplied, rollbackSucceeded, guildId, userId, roleId) {
    if (!roleApplied || typeof sendWebhookEventSafe !== "function") return;
    sendWebhookEventSafe({
        target: "ALERT",
        severity: rollbackSucceeded ? "WARN" : "ERROR",
        category: "VERIFICATION",
        code: rollbackSucceeded ? "verification.persistence_failure_rolled_back" : "verification.persistence_rollback_failed",
        state: "OPEN",
        guildId,
        title: rollbackSucceeded ? "PERSISTENCE FAILURE (ROLLED BACK)" : "PERSISTENCE ROLLBACK FAILED",
        description: rollbackSucceeded
            ? `บันทึกข้อมูลสำคัญไม่ครบ จึงย้อนยศสมาชิกกลับแล้ว (userId=${userId}, roleId=${roleId})`
            : `การย้อนยศสมาชิกล้มเหลวหลังข้อมูลสำคัญบันทึกไม่ครบ (userId=${userId}, roleId=${roleId}): ต้องตรวจสอบด้วยตนเอง`
    }).catch(() => {});
}

async function persistRecoveryRecord(saveRecovery, recovery, guildId, userId, roleId) {
    let recoveryPersisted = false;
    try {
        recoveryPersisted = await saveRecovery(recovery) === true;
    } catch {
        recoveryPersisted = false;
    }

    if (!recoveryPersisted && typeof sendWebhookEventSafe === "function") {
        sendWebhookEventSafe({
            target: "ALERT",
            severity: "CRITICAL",
            category: "VERIFICATION",
            code: "verification.recovery_record_save_failed",
            state: "OPEN",
            guildId,
            title: "RECOVERY RECORD SAVE FAILED",
            description: `ไม่สามารถบันทึกประวัติการกู้คืน (Recovery Record) ลงฐานข้อมูลได้ (userId=${userId}, roleId=${roleId}): ข้อมูลสำคัญอาจตกหล่น ต้องตรวจสอบทันที`
        }).catch(() => {});
    }
    return recoveryPersisted;
}

async function coordinatePersistenceFailure({
    requestId,
    guildId,
    userId,
    roleId,
    result = "failed",
    roleAssignResult,
    roleApplied: explicitRoleApplied,
    persistence,
    removeRole,
    saveRecovery,
    now = Date.now
}) {
    const roleApplied = typeof explicitRoleApplied === "boolean"
        ? explicitRoleApplied
        : roleWasApplied(roleAssignResult || result, roleAssignResult);

    const { rollbackAttempted, rollbackSucceeded } = await executeRoleRollback(roleApplied, removeRole);
    notifyRollbackOutcome(roleApplied, rollbackSucceeded, guildId, userId, roleId);

    const recovery = {
        requestId,
        guildId,
        userId,
        roleId,
        result,
        status: rollbackSucceeded ? "role_rolled_back" : "manual_review_required",
        persistence,
        roleApplied,
        rollbackAttempted,
        rollbackSucceeded,
        reason: "transaction_critical_persistence_failed",
        updatedAt: now()
    };

    const recoveryPersisted = await persistRecoveryRecord(saveRecovery, recovery, guildId, userId, roleId);

    return {
        rollbackAttempted,
        rollbackSucceeded,
        manualReviewRequired: !rollbackSucceeded,
        recoveryPersisted,
        recovery,
        response: {
            success: false,
            error: rollbackSucceeded
                ? "ระบบบันทึกหลักฐานไม่สำเร็จ จึงย้อนยศกลับแล้ว กรุณาลองใหม่"
                : "ระบบบันทึกหลักฐานไม่สำเร็จ ต้องให้ผู้ดูแลตรวจสอบก่อน",
            code: "verification_persistence_failed",
            debugCode: "verification_persistence_failed",
            requestId,
            manualReviewRequired: !rollbackSucceeded,
            recoveryPersisted
        }
    };
}

module.exports = {
    evaluateCriticalPersistence,
    roleWasApplied,
    coordinatePersistenceFailure
};
