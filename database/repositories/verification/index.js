"use strict";

const VerificationRecoveryRepository = require("../../sqlite/repositories/core/VerificationRecoveryRepository");
const VerificationStateNonceRepository = require("../../sqlite/repositories/temp/VerificationStateNonceRepository");
const VerificationWebhookRepository = require("../../sqlite/repositories/core/VerificationWebhookRepository");

let recoveryInstance = null;
let nonceInstance = null;
let webhookInstance = null;

function getVerificationRecoveryRepository() {
    if (!recoveryInstance) recoveryInstance = new VerificationRecoveryRepository();
    return recoveryInstance;
}

function getVerificationStateNonceRepository() {
    if (!nonceInstance) nonceInstance = new VerificationStateNonceRepository();
    return nonceInstance;
}

function getVerificationWebhookRepository() {
    if (!webhookInstance) webhookInstance = new VerificationWebhookRepository();
    return webhookInstance;
}

module.exports = {
    getVerificationRecoveryRepository,
    getVerificationStateNonceRepository,
    getVerificationWebhookRepository
};
