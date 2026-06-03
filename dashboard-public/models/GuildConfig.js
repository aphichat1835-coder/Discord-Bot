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
        /*
          default เป็น false จะปลอดภัยกว่า:
          OAuth access token ใช้ตอน callback พอ
          ถ้าจะเก็บ token จริงค่อยเปิด STORE_OAUTH_TOKENS=true
        */
        storeOAuthTokens:              { type: Boolean, default: false },
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
schema.index({ 'verification.messageId': 1 });
schema.index({ 'verification.panelRevision': 1 });
schema.index({ 'verification.verifyType': 1 });
schema.index({ updatedAt: -1 });

module.exports =
    mongoose.models.GuildConfig ||
    mongoose.model('GuildConfig', schema);
