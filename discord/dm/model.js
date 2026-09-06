"use strict";

const mongoose = require("mongoose");

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

module.exports = mongoose.models.DmNotification ||
    mongoose.model("DmNotification", dmNotificationSchema);
