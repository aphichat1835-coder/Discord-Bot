/*
 * Unified verification crypto utilities.
 * - New writes use AES-256-GCM with an authenticated tag.
 * - Legacy AES-256-CBC values are still readable for backward compatibility.
 * - Raw IP/device lookup keys use HMAC-SHA256 hashes for safe matching.
 */
const crypto = require('node:crypto');
const net = require('node:net');
const { TextDecoder } = require('node:util');
const { sanitizeLogText } = require('./safeLogger');

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function safeCryptoError(err) {
    return sanitizeLogText(err?.message || err?.name || err || 'unknown').slice(0, 180);
}

function getLegacyServiceKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY');
    // Matches Service 1 key derivation: base64(sha256(key)).slice(0,32) as ASCII bytes
    return Buffer.from(crypto.createHash('sha256').update(String(secret)).digest('base64').substring(0, 32));
}

function getCurrentKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) throw new Error('[CRYPTO] Missing ENCRYPTION_KEY');
    return crypto.createHash('sha256').update(String(secret)).digest();
}

function getLegacyCompatibleKeys() {
    const keys = [getLegacyServiceKey(), getCurrentKey()];
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
    const cipher = crypto.createCipheriv('aes-256-gcm', getCurrentKey(), iv, { authTagLength: 16 });

    const ciphertext = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return `v3:gcm:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
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
    const versioned = parts[0] === 'v2' || parts[0] === 'v3';
    const version = versioned ? parts[0] : 'legacy';
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
        version,
        iv: decodePart(parts[offset], encoding, 12),
        tag: decodePart(parts[offset + 1], encoding, 16),
        ciphertext: decodePart(parts.slice(offset + 2).join(':'), encoding)
    };
}

function decodePlaintext(buffer) {
    try {
        return strictUtf8Decoder.decode(buffer);
    } catch {
        return null;
    }
}

function isPlausiblePlaintext(value) {
    if (typeof value !== 'string' || value.length === 0) return false;

    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        const allowedWhitespace = code === 9 || code === 10 || code === 13;
        if ((code < 32 && !allowedWhitespace) || code === 127) return false;
    }

    return true;
}

function isOAuthTokenPlaintext(value) {
    return isPlausiblePlaintext(value) &&
        value.length >= 8 &&
        value.length <= 4096 &&
        !/\s/.test(value);
}

function isIpPlaintext(value) {
    return typeof value === 'string' && net.isIP(value.trim()) !== 0;
}

function isJsonPlaintext(value) {
    if (!isPlausiblePlaintext(value)) return false;
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

function decryptGcm(payload) {
    const { version, iv, tag, ciphertext } = parseGcmPayload(payload);
    let lastError = null;
    const keys = version === 'v3' ? [getCurrentKey()] : getLegacyCompatibleKeys();

    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                key,
                iv,
                { authTagLength: 16 }
            );
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            const decoded = decodePlaintext(plaintext);
            if (decoded !== null) {
                return {
                    plaintext: decoded,
                    format: version === 'v3' ? 'v3_gcm' : `${version}_gcm`,
                    needsMigration: version !== 'v3'
                };
            }
            lastError = new Error('GCM plaintext is not valid UTF-8');
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No compatible GCM key');
}

function decryptLegacyCbc(payload, validatePlaintext = isPlausiblePlaintext) {
    const parts = payload.split(':');
    if (parts.length < 2) throw new Error('Malformed CBC encrypted payload');

    const iv = decodePart(parts.shift(), 'hex', 16);
    const ciphertext = decodePart(parts.join(':'), 'hex');
    let lastError = null;

    for (const key of getLegacyCompatibleKeys()) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            const plaintext = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            const decoded = decodePlaintext(plaintext);

            if (decoded !== null && validatePlaintext(decoded)) {
                return {
                    plaintext: decoded,
                    format: 'legacy_cbc',
                    needsMigration: true
                };
            }
            lastError = new Error('CBC plaintext validation failed');
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('No compatible CBC key');
}

function decryptDataForMigration(payload, validatePlaintext = isPlausiblePlaintext) {
    if (!payload || typeof payload !== 'string') return null;

    if (payload.startsWith('v3:gcm:') || payload.startsWith('v2:gcm:') || payload.startsWith('gcm:')) {
        try {
            const result = decryptGcm(payload);
            if (!validatePlaintext(result.plaintext)) {
                throw new Error('GCM plaintext validation failed');
            }
            return result;
        } catch (err) {
            reportDecryptFailure('gcm', err);
            return null;
        }
    }

    try {
        return decryptLegacyCbc(payload, validatePlaintext);
    } catch (err) {
        reportDecryptFailure('cbc', err);
        return null;
    }
}

function decryptData(payload, validatePlaintext = isPlausiblePlaintext) {
    return decryptDataForMigration(payload, validatePlaintext)?.plaintext || null;
}

function decryptToken(payload) {
    return decryptData(payload, isOAuthTokenPlaintext);
}

function decryptTokenForMigration(payload) {
    return decryptDataForMigration(payload, isOAuthTokenPlaintext);
}

function decryptIP(payload) {
    return decryptData(payload, isIpPlaintext);
}

function decryptIPForMigration(payload) {
    return decryptDataForMigration(payload, isIpPlaintext);
}

function isCurrentEncryptedPayload(payload) {
    return typeof payload === 'string' && payload.startsWith('v3:gcm:');
}

function hmacValue(value, prefix = 'value') {
    if (value === undefined || value === null || value === '') return null;

    return crypto
        .createHmac('sha256', getHashKey())
        .update(`${prefix}:${String(value).trim().toLowerCase()}`)
        .digest('hex');
}

function safeJsonDecrypt(payload, fallback = null) {
    const raw = decryptData(payload, isJsonPlaintext);
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
    decryptDataForMigration,
    safeJsonDecrypt,
    hmacValue,

    encrypt: encryptData,
    decrypt: decryptData,

    encryptToken: encryptData,
    decryptToken,
    decryptTokenForMigration,

    encryptIP: encryptData,
    decryptIP,
    decryptIPForMigration,
    isCurrentEncryptedPayload,

    hashIP: (ip) => hmacValue(ip, 'ip'),
    hashFingerprint: (fp) => hmacValue(fp, 'fingerprint'),

    _test: {
        decodePlaintext,
        isPlausiblePlaintext,
        isOAuthTokenPlaintext,
        isIpPlaintext,
        isJsonPlaintext
    }
};
