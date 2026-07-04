const mongoose = require('mongoose');

const revealAccessLogSchema = new mongoose.Schema({
    action:       String,
    actor:        String,
    viewedBy:     String,
    viewedAt:     Number,
    guildId:      String,
    targetUserId: String,
    verifyLogId:  String,
    reason:       String,
    ownerNote:    String
}, { _id: false, minimize: false });

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
    viewedBy:   String,
    viewedAt:   Number,
    viewCount:  { type: Number, default: 0 },
    accessLog:  { type: [revealAccessLogSchema], default: [] },

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
schema.index({ status: 1, expiresAt: 1 });
schema.index({ createdAt: -1 });

module.exports = mongoose.models.IPRevealRequest || mongoose.model('IPRevealRequest', schema);
