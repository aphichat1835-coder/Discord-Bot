const mongoose = require('mongoose');

const mixed = mongoose.Schema.Types.Mixed;

const schema = new mongoose.Schema({
    discord: {
        userId:           { type: String, required: true },
        username:         String,
        discriminator:    String,
        globalName:       String,
        displayTag:       String,

        avatarHash:       String,
        avatarUrl:        String,
        bannerHash:       String,
        bannerUrl:        String,
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

        profileSnapshot:  mixed
    },

    oauth: {
        encryptedAccessToken:  String,
        encryptedRefreshToken: String,
        expiresAt:            Number,
        scope:                String,
        tokenType:            String,
        lastRefreshAt:        Number,
        refreshFailCount:     { type: Number, default: 0 },
        lastRefreshError:     String,
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
        iconUrl:                  String,

        owner:                    Boolean,
        permissions:              String,

        isOwner:                  Boolean,
        isAdmin:                  Boolean,
        canManageGuild:           Boolean,
        canManageRoles:           Boolean,
        canBanMembers:            Boolean,
        permissionFlags:          [String],

        features:                 [String],
        approximateMemberCount:   Number,
        approximatePresenceCount: Number,

        snapshot:                 mixed
    }],

    lastMember: {
        guildId:                    String,
        nick:                       String,
        roles:                      [String],
        roleCount:                  Number,
        joinedAt:                   String,
        pending:                    Boolean,
        avatar:                     String,
        avatarUrl:                  String,
        flags:                      Number,
        communicationDisabledUntil: String,
        snapshot:                   mixed
    },

    lastVerify: {
        guildId:    String,
        roleId:     String,
        result:     String,
        verifiedAt: Number,
        riskScore:  Number,
        riskFlags:  [String]
    },

    lastIpTracking: {
        ipHash:             String,
        firstSeenAt:        Number,
        lastSeenAt:         Number,
        totalVerifications: Number,
        uniqueUsers:        Number,
        maxRiskScore:       Number,
        lastRiskScore:      Number
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
schema.index({ 'lastIpTracking.ipHash': 1 });
schema.index({ updatedAt: -1 });

module.exports =
    mongoose.models.OAuthUser ||
    mongoose.model('OAuthUser', schema);
