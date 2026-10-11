'use strict';

const crypto = require('node:crypto');

class ConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigurationError';
    }
}

function getSecretKey() {
    const isProduction = process.env.NODE_ENV === 'production';
    const raw = (process.env.QUEST_TOKEN_SECRET && process.env.QUEST_TOKEN_SECRET.trim()) ||
        (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.trim()) ||
        (process.env.ENCRYPTION_SECRET && process.env.ENCRYPTION_SECRET.trim());

    if (!raw) {
        if (isProduction) {
            throw new ConfigurationError('[QUEST_CRYPTO] ❌ Missing QUEST_TOKEN_SECRET or ENCRYPTION_KEY in production. Encrypting or storing tokens without an explicit encryption master secret is strictly prohibited.');
        }
        return 'dev_quest_secret_key_non_production_only_32b!';
    }

    if (raw.length < 16) {
        return raw.padEnd(16, '0');
    }
    return raw;
}

function deriveKey(secret, salt) {
    return crypto.scryptSync(secret, salt, 32);
}

function encryptToken(token, ownerId = 'system', accountId = 'default') {
    const secret = getSecretKey();
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${ownerId}:${accountId}`));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

    return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        salt: salt.toString('base64'),
        packed: `${ciphertext.toString('base64')}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${salt.toString('base64')}`
    };
}

function decryptToken(encryptedData, ownerId = 'system', accountId = 'default') {
    const secret = getSecretKey();
    let ciphertext, iv, tag, salt;

    if (typeof encryptedData === 'string' && encryptedData.includes(':')) {
        const parts = encryptedData.split(':');
        ciphertext = Buffer.from(parts[0], 'base64');
        iv = Buffer.from(parts[1], 'base64');
        tag = Buffer.from(parts[2], 'base64');
        salt = Buffer.from(parts[3], 'base64');
    } else if (typeof encryptedData === 'object' && encryptedData !== null) {
        ciphertext = Buffer.from(encryptedData.ciphertext, 'base64');
        iv = Buffer.from(encryptedData.iv, 'base64');
        tag = Buffer.from(encryptedData.tag, 'base64');
        salt = Buffer.from(encryptedData.salt, 'base64');
    } else {
        throw new Error('Invalid encrypted token format');
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveKey(secret, salt),
        iv,
        { authTagLength: 16 }
    );
    decipher.setAAD(Buffer.from(`${ownerId}:${accountId}`));
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString('utf8');
    } catch (err) {
        throw new Error(`Token decryption failed: authentication tag mismatch or corrupted ciphertext (${err.message})`);
    }
}

function maskToken(token) {
    if (!token || typeof token !== 'string') return '******';
    if (token.length <= 10) return token.slice(0, 2) + '******' + token.slice(-2);
    return token.slice(0, 6) + '...' + token.slice(-4);
}

module.exports = {
    encryptToken,
    decryptToken,
    maskToken,
    getSecretKey,
    ConfigurationError
};
