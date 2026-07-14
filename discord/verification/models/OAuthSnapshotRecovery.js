"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    userId: { type: String, required: true },
    snapshotVersion: { type: String, required: true },
    complete: { type: Boolean, default: false },
    attemptedModels: { type: [String], default: [] },
    failedModels: { type: [String], default: [] },
    failureCodes: { type: [String], default: [] },
    operationResults: { type: mongoose.Schema.Types.Mixed, default: {} },
    retryCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Number, default: Date.now },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ userId: 1, snapshotVersion: 1 }, { unique: true });
schema.index({ complete: 1, updatedAt: 1 });

module.exports = mongoose.models.OAuthSnapshotRecovery ||
    mongoose.model("OAuthSnapshotRecovery", schema);
