"use strict";

const mongoose = require("mongoose");
const { getVerificationStateNonceRepository } = require("../../../database/repositories/verification");

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

// Note: Source of truth is SQLite VerificationStateNonceRepository.
// We preserve schema for contract inspection without calling mongoose.model("VerificationStateNonce", schema).
const VerificationStateNonceFacade = {
    schema: VerificationStateNonceSchema,
    async create(data) {
        return getVerificationStateNonceRepository().create(data);
    },
    async exists(filter) {
        return getVerificationStateNonceRepository().exists(filter);
    },
    async countDocuments(filter) {
        return getVerificationStateNonceRepository().countDocuments(filter);
    },
    findOne(filter) {
        return {
            async lean() {
                if (filter?.nonceHash) {
                    return getVerificationStateNonceRepository().findByNonceHash(filter.nonceHash);
                }
                return null;
            }
        };
    },
    async deleteMany() {
        return { acknowledged: true, deletedCount: 0 };
    },
    findOneAndUpdate(filter, update, options) {
        return {
            async lean() {
                const repo = getVerificationStateNonceRepository();
                const consumed = repo.consume({
                    nonceHash: filter.nonceHash,
                    guildId: filter.guildId,
                    roleId: filter.roleId
                });
                if (!consumed) return null;
                return {
                    status: "consumed",
                    consumedAt: new Date()
                };
            }
        };
    }
};

module.exports = VerificationStateNonceFacade;
