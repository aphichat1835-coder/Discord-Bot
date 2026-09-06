'use strict';

const ScheduledRunner = require('../models/ScheduledRunner');
const { encryptToken, decryptToken } = require('./tokenCrypto');

async function createScheduledRunner({
    ownerId,
    guildId = null,
    channelId,
    accountId,
    username = '',
    token,
    nextCheckAt = null
}) {
    const encrypted = encryptToken(token, ownerId, accountId);
    const doc = await ScheduledRunner.create({
        ownerId,
        guildId,
        channelId,
        accountId,
        username,
        token_ciphertext: encrypted.ciphertext,
        token_iv: encrypted.iv,
        token_tag: encrypted.tag,
        token_salt: encrypted.salt,
        mode: 'scheduled',
        enabled: true,
        nextCheckAt
    });
    return doc.toObject();
}

async function getScheduledRunner(id) {
    if (ScheduledRunner.db?.readyState !== 1) return null;
    return ScheduledRunner.findById(id).lean();
}

async function findScheduledRunner(ownerId, accountId) {
    if (ScheduledRunner.db?.readyState !== 1) return null;
    return ScheduledRunner.findOne({ ownerId, accountId }).lean();
}

async function findAnyScheduledRunner(accountId) {
    if (ScheduledRunner.db?.readyState !== 1) return null;
    return ScheduledRunner.findOne({ accountId, enabled: true }).lean();
}

async function listScheduledRunners(ownerId = null) {
    if (ScheduledRunner.db?.readyState !== 1) return [];
    const filter = { enabled: true };
    if (ownerId != null) filter.ownerId = ownerId;
    return ScheduledRunner.find(filter).sort({ createdAt: 1 }).lean();
}

async function updateScheduledRunner(id, updates = {}) {
    const setFields = {};
    if (updates.username !== undefined) setFields.username = updates.username;
    if (updates.channelId !== undefined) setFields.channelId = updates.channelId;
    if (updates.nextCheckAt !== undefined) setFields.nextCheckAt = updates.nextCheckAt;
    if (updates.lastCheckAt !== undefined) setFields.lastCheckAt = updates.lastCheckAt;
    if (updates.lastError !== undefined) setFields.lastError = updates.lastError;
    if (updates.enabled !== undefined) setFields.enabled = updates.enabled;

    return ScheduledRunner.findByIdAndUpdate(id, { $set: setFields }, { new: true }).lean();
}

async function deleteScheduledRunner(id, ownerId = null) {
    const filter = { _id: id };
    if (ownerId != null) filter.ownerId = ownerId;
    const res = await ScheduledRunner.deleteOne(filter);
    return res.deletedCount > 0;
}

async function deleteAllScheduledRunners(ownerId) {
    const res = await ScheduledRunner.deleteMany({ ownerId });
    return res.deletedCount;
}

function decryptRunnerRecordToken(record) {
    if (!record) throw new Error('Scheduled runner record is required');
    return decryptToken({
        ciphertext: record.token_ciphertext,
        iv: record.token_iv,
        tag: record.token_tag,
        salt: record.token_salt
    }, record.ownerId, record.accountId);
}

module.exports = {
    createScheduledRunner,
    getScheduledRunner,
    findScheduledRunner,
    findAnyScheduledRunner,
    listScheduledRunners,
    updateScheduledRunner,
    deleteScheduledRunner,
    deleteAllScheduledRunners,
    decryptRunnerRecordToken
};
