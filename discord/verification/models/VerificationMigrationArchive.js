"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    migrationVersion: { type: Number, required: true },
    sourceCollection: { type: String, required: true },
    sourceId: { type: String, required: true },
    contentHash: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    privacyRedactions: { type: [mongoose.Schema.Types.Mixed], default: [] },
    backedUpAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index(
    { migrationVersion: 1, sourceCollection: 1, sourceId: 1 },
    { unique: true }
);
schema.index({ backedUpAt: -1 });

module.exports = mongoose.models.VerificationMigrationArchive ||
    mongoose.model("VerificationMigrationArchive", schema);
