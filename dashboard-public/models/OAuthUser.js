const mongoose = require('mongoose');

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
        premiumType:      Number,
        flags:            Number,
        publicFlags:      Number,
        accountCreatedAt: Number,
        accountAgeDays:   Number
    },

    oauth: {
        encryptedAccessToken:  String,
        encryptedRefreshToken: String,
        expiresAt:            Number,
        scope:                String,
        tokenType:            String,
        lastRefreshAt:        Number,
        refreshFailCount:     { type: Number, default: 0 },
        revokedAt:            Number
    },

    connections: [{
        type:       String,
        id:         String,
        name:       String,
        verified:   Boolean,
        visibility: Number
    }],

    guilds: [{
        id:          String,
        name:        String,
        icon:        String,
        owner:       Boolean,
        permissions: String
    }],

    lastVerify: {
        guildId:    String,
        roleId:     String,
        result:     String,
        verifiedAt: Number,
        riskScore:  Number
    },

    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ 'discord.userId': 1 }, { unique: true });
schema.index({ 'lastVerify.guildId': 1, 'lastVerify.verifiedAt': -1 });

module.exports = mongoose.models.OAuthUser || mongoose.model('OAuthUser', schema);
