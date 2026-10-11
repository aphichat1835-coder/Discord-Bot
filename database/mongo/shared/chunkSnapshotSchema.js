"use strict";

const mongoose = require("mongoose");

function buildChunkSnapshotSchema() {
    const schema = new mongoose.Schema({
        userId: { type: String, required: true },
        snapshotVersion: { type: String, required: true },
        chunkIndex: { type: Number, required: true },
        items: { type: [mongoose.Schema.Types.Mixed], default: [] },
        itemCount: { type: Number, required: true },
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
        { userId: 1, snapshotVersion: 1, chunkIndex: 1 },
        { unique: true }
    );
    schema.index({ complete: 1, updatedAt: 1 });
    return schema;
}

function registerChunkSnapshotModel(name) {
    return mongoose.models[name] || mongoose.model(name, buildChunkSnapshotSchema());
}

module.exports = { buildChunkSnapshotSchema, registerChunkSnapshotModel };
