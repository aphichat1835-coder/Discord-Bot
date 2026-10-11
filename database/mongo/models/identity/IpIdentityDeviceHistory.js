"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    guildId: { type: String, required: true },
    ipHash: { type: String, required: true },
    fingerprintHash: { type: String, required: true },
    userId: { type: String, required: true },
    fingerprintVersion: Number,
    firstSeenAt: Number,
    lastSeenAt: Number,
    count: { type: Number, default: 0 },
    browser: String,
    os: String,
    platform: String,
    deviceType: String,
    language: String,
    timezone: String,
    screenSize: String,
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index(
    { guildId: 1, ipHash: 1, fingerprintHash: 1, userId: 1 },
    { unique: true }
);
schema.index({ guildId: 1, userId: 1, lastSeenAt: -1 });
schema.index({ guildId: 1, ipHash: 1, lastSeenAt: -1 });

module.exports = mongoose.models.IpIdentityDeviceHistory ||
    mongoose.model("IpIdentityDeviceHistory", schema);
