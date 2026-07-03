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

function getLegacyRawKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY');
    return crypto.createHash('sha256').update(String(secret)).digest();
}

function getCompatibleKeys() {
    const keys = [getKey(), getLegacyRawKey()];
    return keys.filter((key, index) =>
        keys.findIndex(candidate => candidate.equals(key)) === index
    );
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
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv, { authTagLength: 16 });

    const ciphertext = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return `v2:gcm:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

const reportedDecryptFailures = new Set();

function reportDecryptFailure(format, err) {
    if (reportedDecryptFailures.has(format)) return;
    reportedDecryptFailures.add(format);
    console.error(
        `[CRYPTO] ${format.toUpperCase()} decrypt failed for all compatible formats/keys:`,
        safeCryptoError(err)
    );
}

function decodePart(value, encoding, expectedBytes = null) {
    const text = String(value || '');
    const valid = encoding === 'hex'
        ? text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text)
        : /^[A-Za-z0-9_-]+$/.test(text);

    if (!valid) throw new Error(`Invalid ${encoding} encrypted payload`);

    const decoded = Buffer.from(text, encoding);
    if (expectedBytes !== null && decoded.length !== expectedBytes) {
        throw new Error(`Invalid encrypted payload length`);
    }
    return decoded;
}

function parseGcmPayload(payload) {
    const parts = payload.split(':');
    const versioned = parts[0] === 'v2';
    const offset = versioned ? 2 : 1;

    if ((versioned && parts[1] !== 'gcm') || parts.length < offset + 3) {
        throw new Error('Malformed GCM encrypted payload');
    }

    const looksLikeLegacyHex = !versioned &&
        /^[0-9a-f]{24}$/i.test(parts[offset] || '') &&
        /^[0-9a-f]{32}$/i.test(parts[offset + 1] || '') &&
        /^[0-9a-f]+$/i.test(parts.slice(offset + 2).join('')) &&
        parts.slice(offset + 2).join('').length % 2 === 0;
    const encoding = looksLikeLegacyHex ? 'hex' : 'base64url';

    return {
        iv: decodePart(parts[offset], encoding, 12),
        tag: decodePart(parts[offset + 1], encoding, 16),
        ciphertext: decodePart(parts.slice(offset + 2).join(':'), encoding)
    };
}

function decryptGcm(payload) {
    const { iv, tag, ciphertext } = parseGcmPayload(payload);
    let lastError = null;

    for (const key of getCompatibleKeys()) {
        try {
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                key,
                iv,
                { authTagLength: 16 }
            );
            decipher.setAuthTag(tag);
            return Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]).toString('utf8');
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No compatible GCM key');
}

function decryptLegacyCbc(payload) {
    const parts = payload.split(':');
    if (parts.length < 2) throw new Error('Malformed CBC encrypted payload');

    const iv = decodePart(parts.shift(), 'hex', 16);
    const ciphertext = decodePart(parts.join(':'), 'hex');
    let lastError = null;

    for (const key of getCompatibleKeys()) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            return Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]).toString('utf8');
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No compatible CBC key');
}

function decryptData(payload) {
    if (!payload || typeof payload !== 'string') return null;

    if (payload.startsWith('v2:gcm:') || payload.startsWith('gcm:')) {
        try {
            return decryptGcm(payload);
        } catch (err) {
            reportDecryptFailure('gcm', err);
            return null;
        }
    }

    try {
        return decryptLegacyCbc(payload);
    } catch (err) {
        reportDecryptFailure('cbc', err);
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
