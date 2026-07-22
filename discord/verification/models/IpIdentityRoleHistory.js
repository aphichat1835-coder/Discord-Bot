"use strict";

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    ipHash: { type: String, required: true },
    userId: { type: String, required: true },
    roleId: String,
    roles: [String],
    result: String,
    at: Number,
    source: { type: String, default: "oauth_verification" },
    createdAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ guildId: 1, ipHash: 1, at: -1, _id: -1 });
schema.index({ guildId: 1, userId: 1, at: -1, _id: -1 });

module.exports = mongoose.models.IpIdentityRoleHistory ||
    mongoose.model("IpIdentityRoleHistory", schema);
