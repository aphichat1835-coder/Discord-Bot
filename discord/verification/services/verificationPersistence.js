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

let sendWebhookEventSafe = null;
try {
    const { sendWebhookEvent } = require("../../core/webhooks");
    sendWebhookEventSafe = sendWebhookEvent;
} catch {
    // optional in isolated unit tests
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
    let rollbackAttempted = false;
    let rollbackSucceeded = false;

    if (roleApplied && typeof removeRole === "function") {
        rollbackAttempted = true;
        try {
            const rollback = await removeRole();
            rollbackSucceeded = rollback?.ok === true;
        } catch {
            rollbackSucceeded = false;
        }
    }

    if (roleApplied && typeof sendWebhookEventSafe === "function") {
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

    let recoveryPersisted = false;
    try {
        recoveryPersisted = await saveRecovery(recovery) === true;
    } catch {
        recoveryPersisted = false;
    }

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
