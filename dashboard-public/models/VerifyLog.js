const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    userId:  { type: String, required: true, index: true },

    result: { type: String, enum: ['success', 'failed', 'blocked'], required: true },
    reason: String,

    ipInfo: {
        encryptedRawIp: String,
        country:  String,
        city:     String,
        isp:      String,
        isVPN:    Boolean,
        isProxy:  Boolean,
        isTOR:    Boolean
    },

    device: {
        userAgent: String,
        language:  String,
        timezone:  String,
        platform:  String
    },

    verifiedAt: { type: Number, default: Date.now }
});

// Index เพื่อหา alt accounts (ดู guildId + userId ซ้ำ)
schema.index({ guildId: 1, userId: 1 });

module.exports = mongoose.model('VerifyLog', schema);
