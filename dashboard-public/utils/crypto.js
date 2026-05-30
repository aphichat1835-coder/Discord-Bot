/*
 * AES-256-CBC — ใช้ร่วมกันทั้งระบบ Token + IP
 * Key เดียวกับ main bot (ENCRYPTION_KEY env var)
 */
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
    ? crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('base64').substring(0, 32)
    : null;

if (!ENCRYPTION_KEY) throw new Error('[CRYPTO] ❌ Missing ENCRYPTION_KEY');

function encrypt(text) {
    if (!text) return null;
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let enc = cipher.update(text, 'utf-8', 'hex');
        enc += cipher.final('hex');
        return iv.toString('hex') + ':' + enc;
    } catch (e) {
        console.error('[CRYPTO] encrypt error:', e.message);
        return null;
    }
}

function decrypt(text) {
    if (!text) return null;
    try {
        const parts  = text.split(':');
        const iv     = Buffer.from(parts.shift(), 'hex');
        const encBuf = Buffer.from(parts.join(':'), 'hex');
        const dec    = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let result   = dec.update(encBuf, 'hex', 'utf-8');
        result      += dec.final('utf-8');
        return result;
    } catch (e) {
        console.error('[CRYPTO] decrypt error:', e.message);
        return null;
    }
}

module.exports = {
    encrypt, decrypt,
    encryptToken: encrypt, decryptToken: decrypt,
    encryptIP:    encrypt, decryptIP:    decrypt
};
