"use strict";

const mongoose = require("mongoose");
const { getVerificationRecoveryRepository } = require("../../../database/repositories/verification");

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

// Note: Source of truth is SQLite VerificationRecoveryRepository.
// We preserve schema for contract inspection without calling mongoose.model("VerificationRecovery", schema).
const VerificationRecoveryFacade = {
    schema,
    async create(data) {
        return getVerificationRecoveryRepository().create(data);
    },
    async updateOne(filter, update, options) {
        return getVerificationRecoveryRepository().updateOne(filter, update, options);
    },
    async findOne(filter) {
        return getVerificationRecoveryRepository().findOne(filter);
    },
    async deleteMany(filter) {
        return getVerificationRecoveryRepository().deleteMany(filter);
    },
    async countDocuments(filter) {
        return getVerificationRecoveryRepository().countDocuments(filter);
    }
};

module.exports = VerificationRecoveryFacade;
