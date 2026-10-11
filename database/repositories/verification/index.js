"use strict";

const VerificationRecoveryRepository = require("../../sqlite/repositories/core/VerificationRecoveryRepository");
const VerificationStateNonceRepository = require("../../sqlite/repositories/temp/VerificationStateNonceRepository");

let recoveryInstance = null;
let nonceInstance = null;

function getVerificationRecoveryRepository() {
    if (!recoveryInstance) recoveryInstance = new VerificationRecoveryRepository();
    return recoveryInstance;
}

function getVerificationStateNonceRepository() {
    if (!nonceInstance) nonceInstance = new VerificationStateNonceRepository();
    return nonceInstance;
}

module.exports = {
    getVerificationRecoveryRepository,
    getVerificationStateNonceRepository
};
