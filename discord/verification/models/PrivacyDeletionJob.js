"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true, index: true },
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    subjectHash: { type: String, default: null, index: true },
    operationKey: { type: String, required: true, index: true },
    activeKey: { type: String, default: undefined },
    attempt: { type: Number, default: 1, min: 1 },
    requestedBy: { type: String, required: true },
    status: { type: String, enum: ["pending", "running", "completed", "failed"], default: "pending", index: true },
    manifestVersion: { type: Number, default: 1 },
    manifest: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    errorCode: { type: String, default: null },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now },
    completedAt: { type: Number, default: null }
}, { minimize: false });

schema.index({ status: 1, updatedAt: 1 });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
schema.index({ operationKey: 1, completedAt: -1 });

module.exports = mongoose.models.PrivacyDeletionJob ||
    mongoose.model("PrivacyDeletionJob", schema);
