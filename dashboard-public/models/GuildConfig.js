const mongoose = require('mongoose');

const sensitiveAccessLogSchema = new mongoose.Schema({
    accessedBy: String,
    accessedAt: Number,
    scope:      { type: [String], default: [] },
    route:      String
}, { _id: false, minimize: false });

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

    buttonText:     String,
    buttonLabel:    String,
    buttonEmoji:    String,

    verifyType:     { type: String, default: 'oauth' },
    legacyVerifyType: String
}, { _id: false, minimize: false });

const schema = new mongoose.Schema({
    guildId:   { type: String, required: true, unique: true, index: true },
    guildName: String,

    verification: {
        enabled:              { type: Boolean, default: true },

        roleId:               String,
        roleName:             String,

        channelId:            String,
        channelName:          String,

        messageId:            String,

        /*
          ใช้ rotate/reset state ของแผงยืนยัน:
          - ทุกครั้งที่ส่งแผงใหม่ / แก้แผงเดิม / ปิดระบบ จะเปลี่ยน panelRevision
          - OAuth callback ต้องเช็ก revision ล่าสุด เพื่อกันแผงเก่า/state เก่า
        */
        panelRevision:          String,
        panelRevisionUpdatedAt: Number,

        verifyPath:           { type: String, default: '/auth/callback' },

        /*
          ค่าใหม่สำหรับ Dashboard v2:
          - oauth  = OAuth2 Verification
          - direct = กดรับยศทันที
        */
        verifyType:           { type: String, default: 'oauth' },
        oauthMode:            { type: String, default: 'oauth' },

        /*
          ค่าเก่าเก็บไว้เพื่อ compatibility:
          - direct-discord-authorize-long-lived-state
          - direct-role
        */
        legacyOauthMode:      String,
        directStateMode:      String,

        blockVPN:             { type: Boolean, default: true },
        blockHosting:         { type: Boolean, default: false },
        minAccountAgeDays:    { type: Number,  default: 7 },

        requireEmail:         { type: Boolean, default: false },
        requireEmailVerified: { type: Boolean, default: false },

        requireConnections:   { type: Boolean, default: false },
        minConnections:       { type: Number,  default: 1 },

        allowedCountries:     { type: [String], default: [] },
        blockedCountries:     { type: [String], default: [] },

        antiAlt: {
            enabled:                   { type: Boolean, default: false },

            ipDuplicateAction:         { type: String, default: 'log_only' },
            maxUsersPerIp:             { type: Number, default: 3 },

            deviceDuplicateAction:     { type: String, default: 'log_only' },
            maxUsersPerDevice:         { type: Number, default: 2 },

            previouslyBlockedIpAction: { type: String, default: 'delay' },
            spoofedHeaderAction:       { type: String, default: 'delay' },
            unknownLookupAction:       { type: String, default: 'delay' },

            delayMs:                   { type: Number, default: 5000 }
        },

        panel:                { type: panelSchema, default: () => ({}) },

        updatedBy:            String,
        updatedAt:            { type: Number, default: Date.now }
    },

    security: {
        /*
          default เก็บ token แบบเข้ารหัสเพื่อให้ refresh authorization ต่อเนื่อง
          ถ้าจะปิดให้ตั้ง STORE_OAUTH_TOKENS=false
        */
        storeOAuthTokens:              { type: Boolean, default: true },
        storeRawIpEncrypted:           { type: Boolean, default: true },
        ipRevealRequiresOwnerApproval: { type: Boolean, default: true },
        retentionMode:                 { type: String, default: 'until_admin_delete' },

        /*
          Owner gate for guild-admin visibility of collected sensitive data.
          Collection is unchanged; this only controls normal guild dashboard views.
        */
        sensitiveDataAccess: {
            enabled:    { type: Boolean, default: false },
            scope:      { type: [String], default: ['rawIp', 'email', 'connections', 'guilds'] },
            approvedBy: String,
            approvedAt: Number,
            expiresAt:  Number,
            revokedBy:  String,
            revokedAt:  Number,
            accessedBy: String,
            accessedAt: Number,
            accessLog:  { type: [sensitiveAccessLogSchema], default: [] },
            ownerNote:  { type: String, default: '' },
            updatedAt:  Number
        }
    },

    setupBy:   String,
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
}, { minimize: false });

schema.index({ 'verification.roleId': 1 });
schema.index({ 'verification.channelId': 1 });
schema.index({ 'verification.messageId': 1 });
schema.index({ 'verification.panelRevision': 1 });
schema.index({ 'verification.verifyType': 1 });
schema.index({ updatedAt: -1 });

module.exports =
    mongoose.models.GuildConfig ||
    mongoose.model('GuildConfig', schema);
