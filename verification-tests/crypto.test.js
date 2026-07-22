'use strict';

const crypto = require('node:crypto');

const cryptoUtils = require('../discord/verification/utils/crypto');

function serviceKey(secret) {
    return Buffer.from(
        crypto.createHash('sha256').update(secret).digest('base64').substring(0, 32)
    );
}

function rawLegacyKey(secret) {
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptGcm(plain, key, { prefix, encoding }) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${prefix}:${iv.toString(encoding)}:${tag.toString(encoding)}:${ciphertext.toString(encoding)}`;
}

function encryptCbc(plain, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptCbcCandidate(payload, key) {
    try {
        const [ivHex, ciphertextHex] = payload.split(':');
        const decipher = crypto.createDecipheriv(
            'aes-256-cbc',
            key,
            Buffer.from(ivHex, 'hex')
        );
        return Buffer.concat([
            decipher.update(Buffer.from(ciphertextHex, 'hex')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        return null;
    }
}

function findWrongKeyPaddingSuccess(plain, actualKey, wrongKey) {
    for (let attempt = 0; attempt < 20000; attempt++) {
        const payload = encryptCbc(plain, actualKey);
        const wrongPlaintext = decryptCbcCandidate(payload, wrongKey);

        if (
            wrongPlaintext !== null &&
            !cryptoUtils._test.isOAuthTokenPlaintext(wrongPlaintext)
        ) {
            return payload;
        }
    }
    return null;
}

describe('Dashboard Public crypto compatibility', () => {
    let secret;
    const oldEncryptionKey = process.env.ENCRYPTION_KEY;
    const oldApiSecret = process.env.API_SECRET;

    beforeAll(() => {
        secret = crypto.randomBytes(32).toString('hex');
        process.env.ENCRYPTION_KEY = secret;
        process.env.API_SECRET = crypto.randomBytes(32).toString('hex');
    });

    afterAll(() => {
        if (oldEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = oldEncryptionKey;
        if (oldApiSecret === undefined) delete process.env.API_SECRET;
        else process.env.API_SECRET = oldApiSecret;
    });

    test('round-trips current v2 GCM values', () => {
        const encrypted = cryptoUtils.encryptData('current-value');
        expect(encrypted).toMatch(/^v2:gcm:/);
        expect(cryptoUtils.decryptData(encrypted)).toBe('current-value');
    });

    test('reads v2 GCM values written with the former raw SHA-256 key', () => {
        const encrypted = encryptGcm('raw-key-value', rawLegacyKey(secret), {
            prefix: 'v2:gcm',
            encoding: 'base64url'
        });
        expect(cryptoUtils.decryptData(encrypted)).toBe('raw-key-value');
    });

    test('reads original Service 1-compatible hex GCM values', () => {
        const encrypted = encryptGcm('hex-gcm-value', serviceKey(secret), {
            prefix: 'gcm',
            encoding: 'hex'
        });
        expect(cryptoUtils.decryptData(encrypted)).toBe('hex-gcm-value');
    });

    test('reads CBC values written with either historical key derivation', () => {
        const serviceEncrypted = encryptCbc('service-cbc', serviceKey(secret));
        const rawEncrypted = encryptCbc('raw-cbc', rawLegacyKey(secret));
        expect(cryptoUtils.decryptData(serviceEncrypted)).toBe('service-cbc');
        expect(cryptoUtils.decryptData(rawEncrypted)).toBe('raw-cbc');
    });

    test('continues past a wrong CBC key that only passes padding validation', () => {
        const token = 'legacy-refresh-token-value-12345';
        const encrypted = findWrongKeyPaddingSuccess(
            token,
            rawLegacyKey(secret),
            serviceKey(secret)
        );

        expect(encrypted).not.toBeNull();
        expect(cryptoUtils.decryptToken(encrypted)).toBe(token);
    });

    test('applies payload-specific validation for IP and JSON values', () => {
        const encryptedIp = encryptCbc('203.0.113.10', rawLegacyKey(secret));
        const encryptedJson = encryptCbc('{"ok":true}', rawLegacyKey(secret));

        expect(cryptoUtils.decryptIP(encryptedIp)).toBe('203.0.113.10');
        expect(cryptoUtils.safeJsonDecrypt(encryptedJson)).toEqual({ ok: true });
        expect(cryptoUtils.decryptIP(encryptedJson)).toBeNull();
    });

    test('returns null for malformed or unauthenticated values', () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(cryptoUtils.decryptData('v2:gcm:not-valid:not-valid:not-valid')).toBeNull();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
