"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    guildId: { type: String, required: true },
    ipHash: { type: String, required: true },
    userId: { type: String, required: true },
    username: String,
    globalName: String,
    displayTag: String,
    avatarUrl: String,
    firstSeenAt: Number,
    lastSeenAt: Number,
    verifyCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    blockedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    lastResult: String,
    lastRoleId: String,
    lastRoles: [String],
    lastJoinedAt: String,
    lastMemberPending: Boolean,
    lastCommunicationDisabledUntil: String,
    lastDeviceFingerprintHash: String,
    lastFindings: [String],
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ guildId: 1, ipHash: 1, userId: 1 }, { unique: true });
schema.index({ guildId: 1, userId: 1, lastSeenAt: -1 });
schema.index({ guildId: 1, ipHash: 1, lastSeenAt: -1 });

module.exports = mongoose.models.IpIdentityUserHistory ||
    mongoose.model("IpIdentityUserHistory", schema);
