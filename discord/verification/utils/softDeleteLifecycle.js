"use strict";

const REACTIVATION_UNSET_FIELDS = Object.freeze({
    deletedAt: 1,
    deletedBy: 1
});

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readVerificationResult(update) {
    if (!isPlainObject(update)) return null;
    const set = update.$set;
    if (!isPlainObject(set)) return null;

    if (isPlainObject(set.lastVerify)) {
        return String(set.lastVerify.result || "").trim().toLowerCase() || null;
    }

    if (Object.hasOwn(set, "lastVerify.result")) {
        return String(set["lastVerify.result"] || "").trim().toLowerCase() || null;
    }

    return null;
}

function isVerificationActivationUpdate(update) {
    return readVerificationResult(update) === "success";
}

function applyVerificationReactivation(update) {
    if (!isVerificationActivationUpdate(update)) return false;

    delete update.$set.deletedAt;
    delete update.$set.deletedBy;
    update.$unset = {
        ...(isPlainObject(update.$unset) ? update.$unset : {}),
        ...REACTIVATION_UNSET_FIELDS
    };
    return true;
}

module.exports = {
    REACTIVATION_UNSET_FIELDS,
    readVerificationResult,
    isVerificationActivationUpdate,
    applyVerificationReactivation
};
