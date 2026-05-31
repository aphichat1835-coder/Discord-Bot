const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    guildId: {
        type: String,
        required: true,
        index: true
    },

    targetUserId: {
        type: String,
        required: true,
        index: true
    },

    verifyLogId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'VerifyLog'
    },

    requestedBy: {
        type: String,
        required: true
    },

    reason: {
        type: String,
        default: ''
    },

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'expired'],
        default: 'pending',
        index: true
    },

    approvedBy: String,
    rejectedBy: String,

    approvedAt: Number,
    rejectedAt: Number,

    ownerNote: String,

    expiresAt: {
        type: Number,
        default: () => Date.now() + 7 * 24 * 60 * 60 * 1000
    },

    createdAt: {
        type: Number,
        default: Date.now
    },

    updatedAt: {
        type: Number,
        default: Date.now
    }
}, { minimize: false });

schema.index({ guildId: 1, targetUserId: 1, status: 1 });
schema.index({ createdAt: -1 });

module.exports = mongoose.models.IPRevealRequest || mongoose.model('IPRevealRequest', schema);
