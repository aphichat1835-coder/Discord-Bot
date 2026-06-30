/*
 * Dashboard Public Crypto Utilities
 * - New writes use AES-256-GCM with an authenticated tag.
 * - Legacy AES-256-CBC values are still readable for backward compatibility.
 * - Raw IP/device lookup keys use HMAC-SHA256 hashes for safe matching.
 */
const crypto = require('node:crypto');
const { sanitizeLogText } = require('./safeLogger');

function safeCryptoError(err) {
    return sanitizeLogText(err?.message || err?.name || err || 'unknown').slice(0, 180);
}

function getKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY');
    // Matches Service 1 key derivation: base64(sha256(key)).slice(0,32) as ASCII bytes
    return Buffer.from(crypto.createHash('sha256').update(String(secret)).digest('base64').substring(0, 32));
}

function getLegacyKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY');
    // Legacy raw SHA-256 key (pre-Service 1 alignment)
    return crypto.createHash('sha256').update(String(secret)).digest();
}

function getHashKey() {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY for hash key');

    const authSecret = process.env.API_SECRET || process.env.INTERNAL_API_SECRET;
    if (!authSecret) throw new Error('[CRYPTO] Missing API_SECRET/INTERNAL_API_SECRET for hash key');

    return crypto.createHash('sha256')
        .update(`${encryptionKey}:${authSecret}`)
        .digest();
}

function encryptData(value) {
    if (value === undefined || value === null || value === '') return null;

    const plain = typeof value === 'string' ? value : JSON.stringify(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);

    const ciphertext = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return `v2:gcm:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptWithCandidateKeys(parts, algorithm, ivEncoding, keys) {
    for (const key of keys) {
        try {
            const iv = Buffer.from(parts[0], ivEncoding);

            if (algorithm === 'aes-256-gcm') {
                const tag = Buffer.from(parts[1], 'base64url');
                const ct = Buffer.from(parts.slice(2).join(':'), 'base64url');
                const decipher = crypto.createDecipheriv(algorithm, key, iv);
                decipher.setAuthTag(tag);
                return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
            } else {
                const ciphertext = Buffer.from(parts.slice(1).join(':'), 'hex');
                const decipher = crypto.createDecipheriv(algorithm, key, iv);
                return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
            }
        } catch {
            continue;
        }
    }
    return null;
}

function decryptData(payload) {
    if (!payload || typeof payload !== 'string') return null;

    if (payload.startsWith('v2:gcm:') || payload.startsWith('gcm:')) {
        try {
            const parts = payload.split(':');
            const offset = parts[0] === 'v2' ? 2 : 1;

            const iv = Buffer.from(parts[offset], 'base64url');
            const tag = Buffer.from(parts[offset + 1], 'base64url');
            const ciphertext = Buffer.from(parts.slice(offset + 2).join(':'), 'base64url');

            const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
            decipher.setAuthTag(tag);

            return Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]).toString('utf8');
        } catch (err) {
            console.error('[CRYPTO] GCM decrypt failed, trying legacy key:', safeCryptoError(err));
            try {
                const parts = payload.split(':');
                const offset = parts[0] === 'v2' ? 2 : 1;
                const result = decryptWithCandidateKeys(
                    parts.slice(offset),
                    'aes-256-gcm',
                    'base64url',
                    [getLegacyKey()]
                );
                if (result) return result;
            } catch {}
            return null;
        }
    }

    try {
        const parts = payload.split(':');
        if (parts.length < 2) return null;

        const iv = Buffer.from(parts.shift(), 'hex');
        const ciphertext = Buffer.from(parts.join(':'), 'hex');

        const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);

        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString('utf8');
    } catch (err) {
        console.error('[CRYPTO] CBC decrypt failed, trying legacy key:', safeCryptoError(err));
        const parts = payload.split(':');
        if (parts.length < 2) return null;
        const result = decryptWithCandidateKeys(parts, 'aes-256-cbc', 'hex', [getLegacyKey()]);
        if (result) return result;
        console.error('[CRYPTO] CBC legacy decrypt also failed');
        return null;
    }
}

function hmacValue(value, prefix = 'value') {
    if (value === undefined || value === null || value === '') return null;

    return crypto
        .createHmac('sha256', getHashKey())
        .update(`${prefix}:${String(value).trim().toLowerCase()}`)
        .digest('hex');
}

function safeJsonDecrypt(payload, fallback = null) {
    const raw = decryptData(payload);
    if (!raw) return fallback;

    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

module.exports = {
    encryptData,
    decryptData,
    safeJsonDecrypt,
    hmacValue,

    encrypt: encryptData,
    decrypt: decryptData,

    encryptToken: encryptData,
    decryptToken: decryptData,

    encryptIP: encryptData,
    decryptIP: decryptData,

    hashIP: (ip) => hmacValue(ip, 'ip'),
    hashFingerprint: (fp) => hmacValue(fp, 'fingerprint')
};
