/*
 * AES-256-GCM — ใช้ร่วมกันทั้งระบบ Token + IP
 * Key เดียวกับ main bot (ENCRYPTION_KEY env var)
 *
 * Format ใหม่ (GCM):  "gcm:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * Format เก่า (CBC):  "<iv_hex>:<ciphertext_hex>"  — รองรับ backward compat
 */
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
    ? crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32)
    : null;

if (!ENCRYPTION_KEY) throw new Error('[CRYPTO] ❌ Missing ENCRYPTION_KEY');

// ── encrypt ด้วย AES-256-GCM ──
function encrypt(text) {
    if (!text) return null;
    try {
        const iv      = crypto.randomBytes(12); // 96-bit nonce (NIST recommended)
        const cipher  = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY), iv);
        let enc        = cipher.update(text, 'utf-8', 'hex');
        enc           += cipher.final('hex');
        const authTag  = cipher.getAuthTag().toString('hex'); // 128-bit auth tag
        return `gcm:${iv.toString('hex')}:${authTag}:${enc}`;
    } catch (e) {
        console.error('[CRYPTO] GCM encrypt error:', e.message);
        return null;
    }
}

// ── decrypt รองรับทั้ง GCM (ใหม่) และ CBC (เก่า) ──
function decrypt(text) {
    if (!text) return null;

    // ── GCM path: prefix "gcm:" ──
    if (text.startsWith('gcm:')) {
        try {
            const parts    = text.split(':');
            // parts: ['gcm', iv, authTag, ...ciphertext]
            const iv       = Buffer.from(parts[1], 'hex');
            const authTag  = Buffer.from(parts[2], 'hex');
            const encBuf   = Buffer.from(parts.slice(3).join(':'), 'hex');
            const dec      = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY), iv);
            dec.setAuthTag(authTag);
            let result     = dec.update(encBuf, 'hex', 'utf-8');
            result        += dec.final('utf-8');
            return result;
        } catch (e) {
            console.error('[CRYPTO] GCM decrypt error:', e.message);
            return null;
        }
    }

    // ── CBC path (backward compat): "iv:ciphertext" ──
    try {
        const parts  = text.split(':');
        const iv     = Buffer.from(parts.shift(), 'hex');
        const encBuf = Buffer.from(parts.join(':'), 'hex');
        const dec    = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let result   = dec.update(encBuf, 'hex', 'utf-8');
        result      += dec.final('utf-8');
        return result;
    } catch (e) {
        console.error('[CRYPTO] CBC decrypt error:', e.message);
        return null;
    }
}

module.exports = {
    encrypt, decrypt,
    encryptToken: encrypt, decryptToken: decrypt,
    encryptIP:    encrypt, decryptIP:    decrypt
};
