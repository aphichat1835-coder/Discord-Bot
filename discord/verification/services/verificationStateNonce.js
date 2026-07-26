"use strict";

const crypto = require("node:crypto");
const VerificationStateNonce = require("../models/VerificationStateNonce");

function nonceHash(nonce) {
    return crypto.createHash("sha256").update(String(nonce || "")).digest("hex");
}

async function registerVerificationState(stateObj) {
    if (!stateObj?.nonce || !stateObj.guildId || !stateObj.roleId || !Number.isFinite(Number(stateObj.ts))) return false;
    await VerificationStateNonce.create({
        nonceHash: nonceHash(stateObj.nonce),
        guildId: stateObj.guildId,
        roleId: stateObj.roleId,
        expectedUserId: stateObj.expectedUserId || null,
        panelRevision: stateObj.panelRevision || null,
        status: "pending",
        expiresAt: new Date(Number(stateObj.ts))
    });
    return true;
}

async function consumeVerificationState(stateObj) {
    if (!stateObj?.nonce) return false;
    const now = new Date();
    const updated = await VerificationStateNonce.findOneAndUpdate(
        {
            nonceHash: nonceHash(stateObj.nonce),
            guildId: stateObj.guildId,
            roleId: stateObj.roleId,
            status: "pending",
            expiresAt: { $gt: now }
        },
        {
            $set: {
                status: "consumed",
                consumedAt: now
            }
        },
        { new: true }
    ).lean();
    return Boolean(updated);
}

module.exports = {
    nonceHash,
    registerVerificationState,
    consumeVerificationState
};
