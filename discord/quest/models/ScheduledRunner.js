'use strict';

const mongoose = require('mongoose');

const scheduledRunnerSchema = new mongoose.Schema({
    ownerId: { type: String, required: true, index: true },
    guildId: { type: String, default: null, index: true },
    channelId: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    token_ciphertext: { type: String, required: true },
    token_iv: { type: String, required: true },
    token_tag: { type: String, required: true },
    token_salt: { type: String, required: true },
    mode: { type: String, enum: ['scheduled'], default: 'scheduled' },
    enabled: { type: Boolean, default: true, index: true },
    nextCheckAt: { type: Date, default: null },
    lastCheckAt: { type: Date, default: null },
    lastError: { type: String, default: null }
}, {
    timestamps: true,
    collection: 'scheduled_runners'
});

scheduledRunnerSchema.index({ ownerId: 1, accountId: 1 });
scheduledRunnerSchema.index({ nextCheckAt: 1, enabled: 1 });

module.exports = mongoose.models.ScheduledRunner || mongoose.model('ScheduledRunner', scheduledRunnerSchema);
