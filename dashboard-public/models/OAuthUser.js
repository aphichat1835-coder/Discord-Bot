const mongoose = require('mongoose');

const mixed = mongoose.Schema.Types.Mixed;

const schema = new mongoose.Schema({
    discord: {
        userId:           { type: String, required: true },
        username:         String,
        discriminator:    String,
        globalName:       String,
        avatarHash:       String,
        avatarUrl:        String,
        bannerHash:       String,
        accentColor:      Number,
        email:            String,
        emailVerified:    Boolean,
        locale:           String,
        mfaEnabled:       Boolean,
        premiumType:      Number,
        flags:            Number,
        publicFlags:      Number,
        accountCreatedAt: Number,
        accountAgeDays:   Number,
        rawProfile:       mixed
    },

    oauth: {
        encryptedAccessToken:  String,
        encryptedRefreshToken: String,
        expiresAt:            Number,
        scope:                String,
        tokenType:            String,
        lastRefreshAt:        Number,
        refreshFailCount:     { type: Number, default: 0 },
        revokedAt:            Number,
        rawTokenMeta:          mixed
    },

    connections: [{
        type:         String,
        id:           String,
        name:         String,
        verified:     Boolean,
        visibility:   Number,
        friendSync:   Boolean,
        showActivity: Boolean,
        twoWayLink:   Boolean,
        revoked:      Boolean,
        integrations: mixed,
        metadata:     mixed,
        raw:          mixed
    }],

    guilds: [{
        id:                       String,
        name:                     String,
        icon:                     String,
        owner:                    Boolean,
        permissions:              String,
        features:                 [String],
        approximateMemberCount:   Number,
        approximatePresenceCount: Number,
        raw:                      mixed
    }],

    lastMember: {
        guildId:                    String,
        nick:                       String,
        roles:                      [String],
        joinedAt:                   String,
        pending:                    Boolean,
        avatar:                     String,
        communicationDisabledUntil: String,
        raw:                        mixed
    },

    lastVerify: {
        guildId:    String,
        roleId:     String,
        result:     String,
        verifiedAt: Number,
        riskScore:  Number,
        riskFlags:  [String]
    },

    deletedAt: Number,
    deletedBy: String,

    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ 'discord.userId': 1 }, { unique: true });
schema.index({ 'discord.email': 1 });
schema.index({ 'lastVerify.guildId': 1, 'lastVerify.verifiedAt': -1 });
schema.index({ 'lastVerify.result': 1 });
schema.index({ updatedAt: -1 });

module.exports = mongoose.models.OAuthUser || mongoose.model('OAuthUser', schema);
