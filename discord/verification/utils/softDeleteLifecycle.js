"use strict";

const REACTIVATION_UNSET_FIELDS = Object.freeze({
    deletedAt: 1,
    deletedBy: 1
});

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerificationActivationUpdate(update) {
    if (!isPlainObject(update)) return false;
    const set = update.$set;
    return isPlainObject(set) &&
        Object.hasOwn(set, "lastVerify") &&
        isPlainObject(set.lastVerify);
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
    isVerificationActivationUpdate,
    applyVerificationReactivation
};
