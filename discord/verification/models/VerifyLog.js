const mongoose = require('mongoose');

const mixed = mongoose.Schema.Types.Mixed;

const schema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId:  { type: String, required: true },
    roleId:  String,

    requestId: String,

    result: { type: String, enum: ['success', 'failed', 'blocked'], required: true },
    reason: String,

    findings: [String],
    oauthScope: String,
    stateMode: String,

    policySnapshot: mixed,
    discordSnapshot: mixed,
    guildSnapshot: mixed,
    memberSnapshot: mixed,
    joinResult: mixed,
    roleAssignResult: mixed,

    trackingSnapshot: {
        ipHash: String,
        firstSeenAt: Number,
        lastSeenAt: Number,
        totalVerifications: Number,
        uniqueUsers: Number
    },

    dataQuality: mixed,
    snapshotRef: mixed,
    snapshotVersion: String,
    attemptedSnapshotVersion: String,
    ipHistoryMigrationVersion: Number,
    ipHistoryMigratedAt: Number,

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
        asname: String,
        reverse: String,

        isVPN: Boolean,
        isProxy: Boolean,
        isTOR: Boolean,
        hosting: Boolean,
        mobile: Boolean,
        anycast: Boolean,
        networkType: String,

        findings: [String],

        lookupProvider: String,
        lookupStatus: String,
        lookupMessage: String,
        lookupProviders: [String],
        lookupFallbackUsed: Boolean,
        lookupConsensusUsed: Boolean,
        lookupProviderCount: Number,
        accuracyRadiusKm: Number,
        locationAccuracy: String,
        locationConfidence: String,
        locationConfidenceScore: Number,
        locationConfidenceReasons: [String],
        providerAgreement: mixed,
        providerEvidence: mixed,
        browserTimezone: String,
        browserTimezoneMatches: Boolean,
        historyConsistency: mixed,
        securitySignalsAvailable: Boolean,
        lookupRaw: mixed,

        // Raw IP is encrypted at rest and only returned inside the owner boundary.
        ipSource: String,
        headerIps: mixed,
        spoofSuspected: Boolean,
        spoofFlags: [String],
        headerIpConflict: Boolean,

        proxyCheckProvider: String,
        proxyCheckStatus: String,
        proxyCheckRaw: mixed,

        lookupAt: Number
    },

    device: {
        userAgent: String,
        browser: String,
        os: String,
        language: String,
        languages: [String],
        timezone: String,
        platform: String,
        deviceType: String,
        screenSize: String,
        viewportSize: String,
        colorDepth: Number,
        devicePixelRatio: Number,
        touchPoints: Number,
        referrer: String,
        clientHints: mixed,
        userAgentSuspected: Boolean,
        userAgentFlags: [String],
        fingerprintHash: String
    },

    deletedAt: Number,
    deletedBy: String,

    createdAt: { type: Number, default: Date.now },
    verifiedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ guildId: 1, userId: 1 });
schema.index({ userId: 1, snapshotVersion: 1 });
schema.index({ guildId: 1, verifiedAt: -1 });
schema.index({ guildId: 1, result: 1, verifiedAt: -1 });
schema.index({ 'ipInfo.ipHash': 1 });
schema.index({ 'device.fingerprintHash': 1 });
schema.index({ stateMode: 1 });
schema.index({ requestId: 1 });
schema.index({ 'trackingSnapshot.uniqueUsers': -1 });
schema.index({ ipHistoryMigrationVersion: 1, _id: 1 });

module.exports =
    mongoose.models.VerifyLog ||
    mongoose.model('VerifyLog', schema);
