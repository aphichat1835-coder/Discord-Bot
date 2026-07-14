"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, default: null },
    snapshotVersion: { type: String, required: true },
    kind: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    chunkCount: { type: Number, required: true },
    payloadBase64: { type: String, required: true },
    chunkByteLength: { type: Number, required: true },
    chunkSha256: { type: String, required: true },
    payloadByteLength: { type: Number, required: true },
    payloadSha256: { type: String, required: true },
    returnedCount: { type: Number, required: true },
    storedCount: { type: Number, required: true },
    complete: { type: Boolean, default: false },
    fetchStatus: String,
    failureReason: String,
    source: String,
    capturedAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index(
    { userId: 1, snapshotVersion: 1, kind: 1, chunkIndex: 1 },
    { unique: true }
);
schema.index({ complete: 1, updatedAt: 1 });

module.exports = mongoose.models.OAuthObjectChunkSnapshot ||
    mongoose.model("OAuthObjectChunkSnapshot", schema);
