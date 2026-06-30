const mongoose = require('mongoose');

const mixed = mongoose.Schema.Types.Mixed;

const userSchema = new mongoose.Schema({
    userId: String,
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
    lastRiskScore: Number,
    lastRiskFlags: [String]
}, { _id: false, minimize: false });

const deviceSchema = new mongoose.Schema({
    fingerprintHash: String,
    fingerprintVersion: Number,
    userId: String,
    firstSeenAt: Number,
    lastSeenAt: Number,
    count: { type: Number, default: 0 },

    browser: String,
    os: String,
    platform: String,
    deviceType: String,
    language: String,
    timezone: String,
    screenSize: String
}, { _id: false, minimize: false });

const roleSnapshotSchema = new mongoose.Schema({
    userId: String,
    roleId: String,
    roles: [String],
    result: String,
    at: Number
}, { _id: false, minimize: false });

const schema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    guildName: String,

    ipHash: { type: String, required: true, index: true },
    encryptedRawIp: String,

    firstSeenAt: Number,
    lastSeenAt: Number,
    totalVerifications: { type: Number, default: 0 },
    uniqueUsers: { type: Number, default: 0 },

    lastResult: String,
    lastRoleId: String,

    maxRiskScore: { type: Number, default: 0 },
    lastRiskScore: Number,
    lastRiskFlags: [String],

    lastCountry: String,
    lastCountryCode: String,
    lastRegion: String,
    lastCity: String,
    lastTimezone: String,
    lastIsp: String,
    lastOrg: String,
    lastAs: String,
    lastAsname: String,

    isVPN: Boolean,
    isProxy: Boolean,
    isTOR: Boolean,
    hosting: Boolean,
    mobile: Boolean,

    users: [userSchema],
    deviceFingerprints: [deviceSchema],
    roleSnapshots: [roleSnapshotSchema],

    lastIpInfo: mixed,
    lastDevice: mixed,

    deletedAt: Number,
    deletedBy: String,

    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ guildId: 1, ipHash: 1 }, { unique: true });
schema.index({ guildId: 1, lastSeenAt: -1 });
schema.index({ guildId: 1, uniqueUsers: -1 });
schema.index({ guildId: 1, maxRiskScore: -1 });
schema.index({ 'users.userId': 1 });
schema.index({ 'deviceFingerprints.fingerprintHash': 1 });
schema.index({ guildId: 1, 'deviceFingerprints.fingerprintHash': 1 });

module.exports =
    mongoose.models.IpIdentityLink ||
    mongoose.model('IpIdentityLink', schema);
