"use strict";

function evaluateCriticalPersistence({ oauthSaved, verifyLogSaved, trackingRequired, trackingSaved }) {
    const persistence = {
        oauthUser: oauthSaved === true,
        verifyLog: verifyLogSaved === true,
        ipTracking: trackingRequired !== true || trackingSaved === true
    };
    return {
        persistence,
        ok: Object.values(persistence).every(Boolean)
    };
}

function roleWasApplied(result, roleAssignResult) {
    return result === "success" &&
        roleAssignResult?.ok === true &&
        roleAssignResult?.alreadyHadRole !== true;
}

async function coordinatePersistenceFailure({
    requestId,
    guildId,
    userId,
    roleId,
    result,
    roleAssignResult,
    persistence,
    removeRole,
    saveRecovery,
    now = Date.now
}) {
    const roleApplied = roleWasApplied(result, roleAssignResult);
    let rollbackAttempted = false;
    let rollbackSucceeded = false;

    if (roleApplied) {
        rollbackAttempted = true;
        try {
            const rollback = await removeRole();
            rollbackSucceeded = rollback?.ok === true;
        } catch {
            rollbackSucceeded = false;
        }
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
