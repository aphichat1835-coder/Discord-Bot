const mongoose = require('mongoose');

const panelSchema = new mongoose.Schema({
    content:        { type: String, default: '' },
    title:          String,
    description:    String,
    color:          String,
    imageUrl:       String,
    thumbnailUrl:   String,
    footerText:     String,
    titleUrl:       String,
    showTimestamp:  { type: Boolean, default: false },
    buttonLabel:    String,
    buttonEmoji:    String,
    verifyType:     String
}, { _id: false, minimize: false });

const schema = new mongoose.Schema({
    guildId:   { type: String, required: true, unique: true },
    guildName: String,

    verification: {
        enabled:              { type: Boolean, default: true },
        roleId:               String,
        roleName:             String,
        channelId:            String,
        messageId:            String,

        verifyPath:           { type: String, default: '/auth/callback' },
        oauthMode:            String,
        directStateMode:      String,

        blockVPN:             { type: Boolean, default: true },
        minAccountAgeDays:    { type: Number,  default: 7 },
        requireEmail:         { type: Boolean, default: false },
        requireEmailVerified: { type: Boolean, default: false },
        requireConnections:   { type: Boolean, default: false },
        minConnections:       { type: Number,  default: 1 },
        allowedCountries:     { type: [String], default: [] },
        blockedCountries:     { type: [String], default: [] },

        panel:                { type: panelSchema, default: () => ({}) },

        updatedBy:            String,
        updatedAt:            { type: Number, default: Date.now }
    },

    security: {
        storeOAuthTokens:              { type: Boolean, default: true },
        storeRawIpEncrypted:           { type: Boolean, default: true },
        ipRevealRequiresOwnerApproval: { type: Boolean, default: true },
        retentionMode:                 { type: String, default: 'until_admin_delete' }
    },

    setupBy:   String,
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ 'verification.roleId': 1 });
schema.index({ 'verification.channelId': 1 });
schema.index({ updatedAt: -1 });

module.exports =
    mongoose.models.GuildConfig ||
    mongoose.model('GuildConfig', schema);
