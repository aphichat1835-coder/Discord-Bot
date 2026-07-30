"use strict";

const mongoose = require("mongoose");

const VerificationStateNonceSchema = new mongoose.Schema({
    nonceHash: { type: String, required: true, unique: true, index: true },
    guildId: { type: String, required: true, index: true },
    roleId: { type: String, required: true },
    expectedUserId: { type: String, default: null },
    panelRevision: { type: String, default: null },
    status: { type: String, enum: ["pending", "consumed", "expired"], default: "pending", index: true },
    createdAt: { type: Date, default: Date.now },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { versionKey: false });

module.exports = mongoose.models.VerificationStateNonce ||
    mongoose.model("VerificationStateNonce", VerificationStateNonceSchema);
