const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId:  { type: String, required: true, index: true },
    roleId:  String,

    result: { type: String, enum: ['success', 'failed', 'blocked'], required: true },
    reason: String,

    riskScore: Number,
    riskFlags: [String],
    oauthScope: String,

    policySnapshot: mongoose.Schema.Types.Mixed,
    discordSnapshot: mongoose.Schema.Types.Mixed,
    memberSnapshot: mongoose.Schema.Types.Mixed,

    ipInfo: {
        encryptedRawIp: String,
        ipHash: String,
        country: String,
        countryCode: String,
        region: String,
        city: String,
        zip: String,
        lat: Number,
        lon: Number,
        timezone: String,
        isp: String,
        org: String,
        as: String,
        isVPN: Boolean,
        isProxy: Boolean,
        isTOR: Boolean,
        hosting: Boolean,
        riskScore: Number,
        lookupProvider: String,
        lookupStatus: String,
        lookupAt: Number
    },

    device: {
        userAgent: String,
        browser: String,
        os: String,
        language: String,
        timezone: String,
        platform: String,
        deviceType: String,
        screenSize: String,
        fingerprintHash: String
    },

    deletedAt: Number,
    deletedBy: String,
    verifiedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ guildId: 1, userId: 1 });
schema.index({ guildId: 1, verifiedAt: -1 });
schema.index({ guildId: 1, result: 1, verifiedAt: -1 });
schema.index({ 'ipInfo.ipHash': 1 });
schema.index({ 'device.fingerprintHash': 1 });

module.exports = mongoose.models.VerifyLog || mongoose.model('VerifyLog', schema);
