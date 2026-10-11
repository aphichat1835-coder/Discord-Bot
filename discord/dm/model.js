"use strict";

const mongoose = require("mongoose");
const { getDmNotificationRepository } = require("../../database/repositories/dm");

const dmNotificationSchema = new mongoose.Schema({
    eventKey: { type: String, required: true, unique: true, index: true },
    recipientId: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    priority: { type: String, enum: ["critical", "high", "normal", "low"], default: "normal", index: true },
    priorityRank: { type: Number, min: 0, max: 3, default: 2, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
        type: String,
        enum: ["pending", "sending", "retrying", "sent", "failed_permanent"],
        default: "pending",
        index: true
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Number, default: Date.now, index: true },
    lastError: { type: String, default: null },
    sentAt: { type: Number, default: null },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }
}, { minimize: false });

dmNotificationSchema.index({ status: 1, nextAttemptAt: 1, priorityRank: 1, createdAt: 1 });

// Note: Source of truth is SQLite DmNotificationRepository.
// We preserve dmNotificationSchema for contract inspection without calling mongoose.model("DmNotification", ...).
const DmNotificationFacade = {
    schema: dmNotificationSchema,
    async create(data) {
        return getDmNotificationRepository().create(data);
    },
    async updateOne(filter, update, options) {
        return getDmNotificationRepository().updateOne(filter, update, options);
    },
    async findOne(filter) {
        return getDmNotificationRepository().findOne(filter);
    },
    async findOneAndUpdate(filter, update, options) {
        const repo = getDmNotificationRepository();
        if (update?.$set?.status === "sending") {
            const claimed = repo.claimRecord({ id: filter._id, _id: filter._id });
            return claimed;
        }
        repo.updateOne(filter, update);
        return repo.findOne(filter);
    },
    find(filter = {}) {
        const repo = getDmNotificationRepository();
        return {
            sort(spec) {
                this._sort = spec;
                return this;
            },
            limit(val) {
                this._limit = val;
                return this;
            },
            async lean() {
                return repo.find(filter, { limit: this._limit, sort: this._sort });
            },
            then(resolve, reject) {
                return this.lean().then(resolve, reject);
            }
        };
    },
    async deleteMany(filter) {
        return getDmNotificationRepository().deleteMany(filter);
    },
    async updateMany(filter, update) {
        return { acknowledged: true, modifiedCount: 0 };
    },
    async countDocuments(filter) {
        return getDmNotificationRepository().countDocuments(filter);
    }
};

module.exports = DmNotificationFacade;
