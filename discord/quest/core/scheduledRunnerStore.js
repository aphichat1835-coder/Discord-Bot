'use strict';

const { getScheduledRunnerRepository } = require('../../../database/repositories/quest');
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
    return getScheduledRunnerRepository().create({
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
}

async function getScheduledRunner(id) {
    return getScheduledRunnerRepository().findById(id);
}

async function findScheduledRunner(ownerId, accountId) {
    return getScheduledRunnerRepository().findOne({ ownerId, accountId });
}

async function findAnyScheduledRunner(accountId) {
    return getScheduledRunnerRepository().findOne({ accountId, enabled: true });
}

async function listScheduledRunners(ownerId = null) {
    const filter = { enabled: true };
    if (ownerId != null) filter.ownerId = ownerId;
    return getScheduledRunnerRepository().find(filter);
}

async function updateScheduledRunner(id, updates = {}) {
    return getScheduledRunnerRepository().updateById(id, updates);
}

async function deleteScheduledRunner(id, ownerId = null) {
    return getScheduledRunnerRepository().deleteById(id, ownerId);
}

async function deleteAllScheduledRunners(ownerId) {
    return getScheduledRunnerRepository().deleteMany({ ownerId });
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
