"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true, index: true },
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    roleId: { type: String, default: null },
    result: { type: String, required: true },
    status: {
        type: String,
        enum: ["pending", "manual_review_required", "role_rolled_back", "resolved"],
        default: "pending",
        index: true
    },
    persistence: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    roleApplied: { type: Boolean, default: false },
    rollbackAttempted: { type: Boolean, default: false },
    rollbackSucceeded: { type: Boolean, default: false },
    reason: { type: String, default: null },
    createdAt: { type: Number, default: Date.now, index: true },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.models.VerificationRecovery ||
    mongoose.model("VerificationRecovery", schema);
