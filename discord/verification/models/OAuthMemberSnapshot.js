"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true, index: true },
    snapshotVersion: { type: String, required: true, index: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    roleSnapshotRef: mongoose.Schema.Types.Mixed,
    roleCount: { type: Number, required: true },
    returnedCount: { type: Number, required: true },
    storedCount: { type: Number, required: true },
    complete: { type: Boolean, default: false, index: true },
    fetchStatus: String,
    failureReason: String,
    source: String,
    capturedAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index(
    { userId: 1, guildId: 1, snapshotVersion: 1 },
    { unique: true }
);

module.exports = mongoose.models.OAuthMemberSnapshot ||
    mongoose.model("OAuthMemberSnapshot", schema);
