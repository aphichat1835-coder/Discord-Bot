'use strict';

const mongoose = require('mongoose');

const questDetailSchema = new mongoose.Schema({
    questId: { type: String, default: '' },
    questName: { type: String, default: '' },
    eventName: { type: String, default: '' },
    progress: { type: Number, default: 0 },
    target: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    claimed: { type: Boolean, default: false },
    error: { type: String, default: null }
}, { _id: false });

const accountRunSchema = new mongoose.Schema({
    targetUserId: { type: String, default: null },
    targetUsername: { type: String, default: null },
    maskedToken: { type: String, required: true },
    encryptedToken: { type: String, required: true },
    status: {
        type: String,
        enum: ['pending', 'running', 'completed', 'failed', 'stopped'],
        default: 'pending'
    },
    questsFound: { type: Number, default: 0 },
    questsCompleted: { type: Number, default: 0 },
    details: [questDetailSchema],
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null }
}, { _id: false });

const questLogSchema = new mongoose.Schema({
    invokerId: { type: String, required: true, index: true },
    invokerTag: { type: String, required: true },
    guildId: { type: String, default: null },
    channelId: { type: String, default: null },
    accounts: [accountRunSchema],
    totalTokens: { type: Number, default: 0 },
    overallStatus: {
        type: String,
        enum: ['in_progress', 'completed', 'partial_failure', 'failed', 'stopped'],
        default: 'in_progress'
    },
    dmDelivered: { type: Boolean, default: false },
    dmError: { type: String, default: null }
}, {
    timestamps: true,
    collection: 'quest_logs'
});

questLogSchema.index({ createdAt: -1 });
questLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Reuse existing model if already registered
module.exports = mongoose.models.QuestLog || mongoose.model('QuestLog', questLogSchema);
