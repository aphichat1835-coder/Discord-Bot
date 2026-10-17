"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    targetVersion: Number,
    status: String,
    lockOwner: String,
    lockUntil: Number,
    lastStartedAt: Number,
    lastFinishedAt: Number,
    lastSuccessAt: Number,
    lastError: String,
    cursorSourceId: String,
    cursorWrappedAt: Number,
    lastSummary: mongoose.Schema.Types.Mixed,
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

module.exports = mongoose.models.VerificationMigrationState ||
    mongoose.model("VerificationMigrationState", schema);
